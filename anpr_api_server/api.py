import cv2
import numpy as np
import onnxruntime
import easyocr
import re
from fastapi import FastAPI, UploadFile, File
from fastapi.responses import JSONResponse
import uvicorn

# --- Initialize models once on startup ---
app = FastAPI()

try:
    # Load the exported ONNX model for detection
    onnx_session = onnxruntime.InferenceSession("best.onnx")
    # Load the OCR model
    ocr_reader = easyocr.Reader(['en'])
except Exception as e:
    print(f"Error loading models: {e}")
    onnx_session = None
    ocr_reader = None

# --- Image Preprocessing for YOLOv8 ---
def preprocess_image(image: np.ndarray, input_shape=(640, 640)):
    """Prepares the image for YOLOv8 object detection."""
    img_h, img_w, _ = image.shape
    
    # Resize image while maintaining aspect ratio
    scale = min(input_shape[0] / img_h, input_shape[1] / img_w)
    new_w, new_h = int(img_w * scale), int(img_h * scale)
    resized_image = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
    
    # Create a new image with padding
    padded_image = np.full((input_shape[0], input_shape[1], 3), 114, dtype=np.uint8)
    dw, dh = (input_shape[1] - new_w) // 2, (input_shape[0] - new_h) // 2
    padded_image[dh:new_h+dh, dw:new_w+dw, :] = resized_image
    
    # Normalize and transpose
    input_tensor = padded_image.astype(np.float32) / 255.0
    input_tensor = np.transpose(input_tensor, (2, 0, 1)) # HWC to CHW
    input_tensor = np.expand_dims(input_tensor, axis=0) # Add batch dimension
    
    return input_tensor, scale, dw, dh

# --- Post-processing for YOLOv8 Output ---
def postprocess_output(output, scale, dw, dh, conf_threshold=0.5):
    """Extracts bounding boxes from YOLOv8 output."""
    boxes = []
    output = output[0].T # Transpose to get [num_detections, 5]
    
    for row in output:
        prob = row[4:].max()
        if prob > conf_threshold:
            xc, yc, w, h = row[:4]
            # Un-pad and scale back to original image coordinates
            x1 = int((xc - dw - w/2) / scale)
            y1 = int((yc - dh - h/2) / scale)
            x2 = int((xc - dw + w/2) / scale)
            y2 = int((yc - dh + h/2) / scale)
            boxes.append([x1, y1, x2, y2])
            
    return boxes

# --- Regex function (unchanged) ---
def extract_plate_number(ocr_text: str) -> str | None:
    STATE_CODES = {
        "AN", "AP", "AR", "AS", "BR", "CH", "CT", "DN", "DD", "DL", "GA",
        "GJ", "HR", "HP", "JK", "JH", "KA", "KL", "LA", "LD", "MP", "MH",
        "MN", "ML", "MZ", "NL", "OD", "PB", "PY", "RJ", "SK", "TN", "TG",
        "TR", "UP", "UT", "WB"
    }
    DIGIT_CORRECTIONS = {
        'O': '0', 'Q': '0', 'D': '0', 'I': '1', 'L': '4', '|': '1', 'Z': '2',
        'S': '5', 'B': '8', 'G': '6', 'T': '7', 'C': '0', 'l': '1'
    }
    LETTER_CORRECTIONS = {
        '0': 'O', '1': 'I', '2': 'Z', '5': 'S', '8': 'B', '6': 'G', '7': 'T'
    }
    text = ocr_text.strip()
    if text.upper().startswith("IND"):
        text = text[3:].strip()
    clean_text = "".join(filter(str.isalnum, text)).upper()
    strict_pattern = re.compile(r"^[A-Z]{2}[0-9]{1,2}[A-Z]{1,2}[0-9]{4}$")
    if strict_pattern.match(clean_text) and clean_text[:2] in STATE_CODES:
        return clean_text
    start_index = -1
    for i in range(len(clean_text) - 1):
        if clean_text[i:i+2] in STATE_CODES:
            start_index = i
            break
    if start_index == -1: return None
    candidate_text = clean_text[start_index:]
    lenient_pattern = re.compile(r"^([A-Z]{2})([A-Z0-9]{1,2})([A-Z0-9]{1,2})([A-Z0-9]{1,4})")
    match = lenient_pattern.match(candidate_text)
    if not match: return None
    groups = list(match.groups())
    groups[1] = "".join([DIGIT_CORRECTIONS.get(char, char) for char in groups[1]])
    groups[2] = "".join([LETTER_CORRECTIONS.get(char, char) for char in groups[2]])
    groups[3] = "".join([DIGIT_CORRECTIONS.get(char, char) for char in groups[3]])
    final_plate = "".join(groups)
    if strict_pattern.match(final_plate):
        return final_plate
    return None

@app.post("/recognize_plate/")
async def recognize_plate(file: UploadFile = File(...)):
    if not onnx_session or not ocr_reader:
        return JSONResponse(status_code=500, content={"error": "Models not loaded"})

    contents = await file.read()
    nparr = np.frombuffer(contents, np.uint8)
    original_image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    # 1. Preprocess the image for YOLOv8
    input_tensor, scale, dw, dh = preprocess_image(original_image)
    
    # 2. Run detection with the ONNX model
    input_name = onnx_session.get_inputs()[0].name
    output_name = onnx_session.get_outputs()[0].name
    outputs = onnx_session.run([output_name], {input_name: input_tensor})

    # 3. Post-process the output to get bounding boxes
    boxes = postprocess_output(outputs[0], scale, dw, dh)

    if not boxes:
        return {"plate_number": None, "raw_text": "No license plate detected."}

    # 4. Crop the plate from the *original* image
    # Assuming the first and most confident detection is the one we want
    x1, y1, x2, y2 = boxes[0]
    # Add a small buffer around the crop
    y1, y2 = max(0, y1 - 5), min(original_image.shape[0], y2 + 5)
    x1, x2 = max(0, x1 - 5), min(original_image.shape[1], x2 + 5)
    plate_crop = original_image[y1:y2, x1:x2]

    if plate_crop.size == 0:
         return {"plate_number": None, "raw_text": "Failed to crop license plate."}

    # 5. Run OCR on the cropped plate and clean the text
    ocr_result = ocr_reader.readtext(plate_crop)
    raw_text = " ".join([res[1] for res in ocr_result])
    plate_number = extract_plate_number(raw_text)

    return {"plate_number": plate_number, "raw_text": raw_text}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
