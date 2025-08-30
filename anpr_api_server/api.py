# api.py
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

# --- Copy your perfected regex function here ---
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
    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    # Note: You will need to add your YOLOv8 preprocessing logic here
    # This usually involves resizing to 640x640, normalizing, and transposing dimensions.
    # For now, this example will process the whole image.
    plate_crop = image 

    # Run OCR and clean the text
    ocr_result = ocr_reader.readtext(plate_crop)
    raw_text = " ".join([res[1] for res in ocr_result])
    plate_number = extract_plate_number(raw_text)

    return {"plate_number": plate_number, "raw_text": raw_text}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)