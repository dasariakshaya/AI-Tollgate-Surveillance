import os
import logging
from flask import Flask, request, jsonify
from werkzeug.utils import secure_filename
import pipeline

# --- Configuration ---
UPLOAD_FOLDER = 'temp_uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
logging.basicConfig(level=logging.INFO)

# --- Pre-load Models ---
logging.info("Initializing OCR models... This may take a moment.")
recognizer = pipeline.AdvancedTextRecognizer()
recognizer.initialize_models()
extractor = pipeline.InformationExtractor()
preprocessor = pipeline.DrivingLicensePreprocessor()
logging.info("✅ Models initialized and ready to receive requests.")

@app.route('/extract-dl', methods=['POST'])
def extract_dl_info():
    if 'dl_image' not in request.files:
        return jsonify({'error': 'No image file part in the request'}), 400
    
    file = request.files['dl_image']

    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400

    # THE FIX IS ON THIS LINE: Added ".jpg" to the temporary filename
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], "temp_image_file.jpg")
    file.save(filepath)
    
    app.logger.info(f"Processing uploaded file saved to: {filepath}")

    try:
        input_handler = pipeline.DrivingLicenseImageInput(filepath)
        image = input_handler.load_image()
        processed_image, _ = preprocessor.preprocess_image(image, show_steps=False)
        ocr_results = recognizer.recognize_text(processed_image)
        extracted_info = extractor.extract_all_info(ocr_results)
        os.remove(filepath)
        
        app.logger.info(f"Successfully extracted DL numbers: {extracted_info.dl_numbers}")
        return jsonify({
            'dl_numbers': extracted_info.dl_numbers,
            'name': extracted_info.name,
            'raw_text': extracted_info.raw_text
        })
    except Exception as e:
        app.logger.error(f"Error processing file: {e}", exc_info=True)
        if os.path.exists(filepath):
            os.remove(filepath)
        return jsonify({'error': f'An error occurred during image processing: {str(e)}'}), 500

# This "if" statement MUST start at the beginning of the line with no indentation.
if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5001)