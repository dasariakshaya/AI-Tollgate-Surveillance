import cv2
from ultralytics import YOLO
import easyocr
import matplotlib.pyplot as plt
import os

def load_model():
    """
    Load YOLOv8 license plate detection model.
    You can replace 'keremberke/yolov8n-license-plate' with a local .pt file if needed.
    """
    return YOLO("keremberke/yolov8n-license-plate")

def detect_and_read(image_path, model, reader):
    """
    Detect license plates using YOLO, crop them, and read text with EasyOCR.
    """
    # Run YOLO detection
    results = model(image_path)

    # Load image for cropping
    image = cv2.imread(image_path)

    plates_text = []

    for r in results:
        for box in r.boxes:
            # Get coordinates
            x1, y1, x2, y2 = map(int, box.xyxy[0])

            # Crop license plate
            cropped_plate = image[y1:y2, x1:x2]

            # Convert BGR → RGB for matplotlib
            cropped_rgb = cv2.cvtColor(cropped_plate, cv2.COLOR_BGR2RGB)

            # OCR with EasyOCR
            ocr_result = reader.readtext(cropped_plate)
            text = " ".join([res[1] for res in ocr_result])

            plates_text.append(text)

            # Show cropped plate and detected text
            plt.imshow(cropped_rgb)
            plt.axis("off")
            plt.title(f"Detected Plate: {text}")
            plt.show()

    return plates_text

def main():
    # Load YOLOv8 model
    model = load_model()

    # Load EasyOCR Reader (English, Hindi, Telugu, etc. if needed)
    reader = easyocr.Reader(['en'])

    # Test image path (replace with your dataset or input image)
    image_path = "test.jpg"

    if not os.path.exists(image_path):
        print(f"❌ Error: {image_path} not found. Please place an image in the project folder.")
        return

    # Detect and read license plates
    detected_texts = detect_and_read(image_path, model, reader)

    if detected_texts:
        print("\n✅ Detected License Plates:")
        for i, text in enumerate(detected_texts, 1):
            print(f"{i}. {text}")
    else:
        print("⚠️ No license plate detected.")

if __name__ == "__main__":
    main()
