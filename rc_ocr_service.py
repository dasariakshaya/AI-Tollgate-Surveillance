# rc_ocr_service.py

from flask import Flask, request, jsonify
import pytesseract
import cv2
import numpy as np
import re
from PIL import Image
import io
import os

app = Flask(__name__)

# IMPORTANT: CONFIGURE TESSERACT PATH
# Uncomment and modify the line below to point to your Tesseract executable.
# Based on your latest success, the path is likely: C:\Program Files\Tesseract-OCR\tesseract.exe
pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'

def preprocess_image_for_ocr(image):
    """
    Refined preprocessing for number plates. Prioritizes clear, binarized text.
    """
    processed_images = []

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    
    # Adaptive Gaussian Thresholding (often best for varying lighting)
    # Parameters (block size, C) are crucial. Fine-tune if needed.
    adaptive_gaussian = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                                cv2.THRESH_BINARY, 15, 5)
    processed_images.append(adaptive_gaussian)

    # OTSU Thresholding (good for consistent lighting, high contrast)
    _, otsu_thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    processed_images.append(otsu_thresh)

    # Simple Binary Thresholding (fallback)
    _, simple_binary = cv2.threshold(gray, 128, 255, cv2.THRESH_BINARY)
    processed_images.append(simple_binary)

    # Sharpened grayscale (can help with blurry images)
    sharpen_kernel = np.array([[-1,-1,-1], [-1,9,-1], [-1,-1,-1]])
    sharpened_gray = cv2.filter2D(gray, -1, sharpen_kernel)
    processed_images.append(sharpened_gray)

    # Original grayscale (as a baseline comparison)
    processed_images.append(gray)

    return processed_images

def extract_text_with_tesseract(image):
    """
    Extract text using Tesseract with various PSM configurations.
    """
    results = []

    # Whitelist of common alphanumeric characters found on Indian plates
    # Ensure this is exhaustive but not too broad to allow more noise.
    # Note: Avoid 'G', 'S' if you have strong corrections for them to '6', '5' respectively.
    # But for 'AS', we need 'A' and 'S'.
    char_whitelist = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

    # PSM (Page Segmentation Mode) options to try
    # 7: Treat the image as a single text line. (Often best for cropped plates)
    # 13: Raw line. Treat the image as a single text line, bypassing Tesseract's internal line layout analysis.
    # 8: Treat the image as a single word.
    # 6: Assume a single uniform block of text.
    # 11: Sparse text. Find as much text as possible in no particular order. (Good for noisy/fragmented text)
    configs = [
        f'--psm 7 -c tessedit_char_whitelist={char_whitelist}',
        f'--psm 13 -c tessedit_char_whitelist={char_whitelist}',
        f'--psm 8 -c tessedit_char_whitelist={char_whitelist}',
        f'--psm 6 -c tessedit_char_whitelist={char_whitelist}',
        f'--psm 11 -c tessedit_char_whitelist={char_whitelist}',
        # Fallback without whitelist, sometimes captures characters the whitelist might exclude due to font variations
        '--psm 7',
        '--psm 13',
        '--psm 8',
        '--psm 6',
        '--psm 11',
    ]

    for config in configs:
        try:
            pil_image = Image.fromarray(image)
            if len(image.shape) == 3: # If BGR image (color), convert to RGB for PIL
                 pil_image = Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))
            else: # If grayscale or binary, use as is
                 pil_image = Image.fromarray(image)

            text = pytesseract.image_to_string(pil_image, config=config).strip()
            if text:
                results.append(text)
        except pytesseract.TesseractNotFoundError:
            raise # Re-raise if Tesseract isn't found
        except Exception as e:
            app.logger.warning(f"Tesseract OCR failed with config '{config}': {e}")
            continue
    return results

def clean_and_validate_rc_number(raw_ocr_text_list):
    """
    Cleans, corrects, and validates RC numbers from a list of raw OCR texts.
    Prioritizes the best valid match based on structure and common corrections.
    """
    if not raw_ocr_text_list:
        return None

    potential_final_rc_numbers = []

    # Character corrections (careful with these!)
    # These map common OCR misreads where letters look like numbers or vice-versa.
    # We are being less aggressive with 'A' to '4' or 'S' to '5' unless needed.
    char_corrections_strict = {
        'O': '0', 'Q': '0', 'D': '0', 'U': '0', 'C': '0',
        'I': '1', 'L': '1', '|': '1', 'J': '1',
        'S': '5', 'G': '6', 'R': '8', # 'R' is often misread as '8'
        'Z': '2', 'V': '4',
        'B': '8', # 'B' is often misread as '8'
        'T': '1' # 'T' can look like '1' sometimes
    }
    
    # Specific patterns to reconstruct a valid RC number.
    # These define the structure (e.g., 2 letters, 2 digits, etc.)
    # We use named groups for clarity and reconstruction.
    # Pattern examples: AS01BY1051, AS15M8075, AP40D6150
    rc_structure_patterns = [
        # XX DD XXXXXX (State_Code RTO_Code Series Vehicle_No)
        # This is the most flexible: 2 letters, 2 digits, 1-3 alphanumeric, 4 digits
        re.compile(r"^([A-Z]{2})([0-9]{2})([A-Z0-9]{1,3})([0-9]{4})$"),
        # More specific strict patterns can be added here if the above is too loose
        # re.compile(r"^([A-Z]{2})([0-9]{2})([A-Z]{2})([0-9]{4})$"), # For XX00XX0000
        # re.compile(r"^([A-Z]{2})([0-9]{2})([A-Z]{1})([0-9]{4})$"), # For XX00X0000
    ]

    for text_from_tesseract in raw_ocr_text_list:
        # Step 1: Broad Cleaning - remove non-alphanumeric, convert to uppercase
        # This transforms "AS O1BY 1051" -> "ASO1BY1051"
        cleaned_stage1 = re.sub(r'[^A-Z0-9]', '', text_from_tesseract.upper())
        
        # Step 2: Apply specific corrections
        # Only apply these corrections here.
        cleaned_stage2 = cleaned_stage1
        for _ in range(2): # Apply corrections a couple of times
            for wrong, right in char_corrections_strict.items():
                cleaned_stage2 = cleaned_stage2.replace(wrong, right)
        
        # Step 3: Iterate through broad candidates in the cleaned text
        # This will find any string resembling a plate number.
        # Lengths of typical Indian plates are 9-11 characters (without spaces).
        # Example: "ASOIBY1051" is 10 chars. "AS15M8075" is 9 chars.
        
        # This regex attempts to find any 9, 10 or 11 character alphanumeric sequence.
        # This is our primary 'candidate grabber' from the cleaned OCR output.
        candidate_grabber = re.compile(r'[A-Z0-9]{9,11}') 
        
        for broad_match in candidate_grabber.finditer(cleaned_stage2):
            candidate_num_str = broad_match.group(0) # e.g., "ASO1BY1051"

            # Step 4: Validate this candidate against strict structural patterns
            for structural_pattern in rc_structure_patterns:
                strict_match = structural_pattern.match(candidate_num_str)
                if strict_match:
                    # If it matches, reconstruct it from groups (ensures correct format)
                    reconstructed_num = "".join(strict_match.groups())
                    
                    # Final sanity check on length (most common 9-10, but 11 is possible)
                    if 9 <= len(reconstructed_num) <= 11:
                        potential_final_rc_numbers.append(reconstructed_num)
                        # We don't break immediately here if you want to find ALL valid matches
                        # from different raw OCR outputs and then pick the absolute best.
                        # If you want the first valid one found from any source, uncomment:
                        # return reconstructed_num 
    
    # Step 5: Prioritize and return the best match if multiple were found
    if potential_final_rc_numbers:
        # Sort by length (shorter implies less noise added by OCR, if still valid)
        # Then alphabetically for consistent tie-breaking.
        potential_final_rc_numbers.sort(key=lambda x: (len(x), x))
        return potential_final_rc_numbers[0]
    
    return None

@app.route('/recognize_rc', methods=['POST'])
def recognize_rc_endpoint():
    if 'rc_image' not in request.files:
        return jsonify({"error": "No image file provided"}), 400

    file = request.files['rc_image']
    if file.filename == '':
        return jsonify({"error": "No selected file"}), 400

    try:
        in_memory_file = io.BytesIO(file.read())
        image_np = np.frombuffer(in_memory_file.read(), np.uint8)
        img = cv2.imdecode(image_np, cv2.IMREAD_COLOR)

        if img is None:
            return jsonify({"error": "Could not decode image. Is it a valid image file?"}), 400

        height, width = img.shape[:2]
        if height < 150 or width < 300: # Upscale small images
            scale_factor = max(300/height, 1.0)
            img = cv2.resize(img, (int(width * scale_factor), int(height * scale_factor)), interpolation=cv2.INTER_CUBIC)
        elif height > 1000 or width > 1500: # Downscale very large images
             scale_factor = min(1000/height, 1500/width, 1.0)
             img = cv2.resize(img, (int(width * scale_factor), int(height * scale_factor)), interpolation=cv2.INTER_AREA)

        processed_images = preprocess_image_for_ocr(img)
        
        all_raw_extracted_texts = []
        
        # Collect all raw OCR results
        for p_img in processed_images:
            texts_from_this_img = extract_text_with_tesseract(p_img)
            all_raw_extracted_texts.extend(texts_from_this_img)
        
        # Now, clean and validate based on the entire collection of raw texts
        # This single call will handle filtering, correcting, and finding the best match.
        best_rc_number_overall = clean_and_validate_rc_number(all_raw_extracted_texts)

        if best_rc_number_overall:
            return jsonify({
                "recognized_text": best_rc_number_overall,
                "status": "success",
                "raw_ocr_results": sorted(list(set(all_raw_extracted_texts)))
            }), 200
        else:
            return jsonify({
                "recognized_text": None,
                "raw_ocr_results": sorted(list(set(all_raw_extracted_texts))),
                "message": "Could not extract valid RC number from any attempt.",
                "status": "no_valid_rc"
            }), 200

    except pytesseract.TesseractNotFoundError:
        return jsonify({
            "error": "Tesseract not found. Please ensure it's installed and path is configured.",
            "message": "Tesseract OCR engine is not accessible to Python service."
        }), 500
    except Exception as e:
        app.logger.error(f"Error during RC recognition endpoint: {str(e)}", exc_info=True)
        return jsonify({"error": str(e), "message": "Internal server error during OCR processing"}), 500

@app.route('/health', methods=['GET'])
def health_check():
    try:
        pytesseract.get_tesseract_version()
        return jsonify({"status": "healthy", "tesseract_status": "found"}), 200
    except Exception as e:
        return jsonify({"status": "unhealthy", "tesseract_status": f"not found: {str(e)}"}), 500

if __name__ == '__main__':
    try:
        tesseract_version = pytesseract.get_tesseract_version()
        print(f"Tesseract version: {tesseract_version} found.")
    except Exception as e:
        print(f"ERROR: Tesseract executable not found or configured: {e}")
        print("Please ensure Tesseract is installed and its path is correctly set in rc_ocr_service.py")
    
    app.run(debug=True, host='0.0.0.0', port=5000)