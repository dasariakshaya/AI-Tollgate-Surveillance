# ===================================================================
#
#   ENHANCED COMPLETE DRIVING LICENSE INFORMATION EXTRACTOR PIPELINE
#
# ===================================================================

import os
import io
import re
import json
import warnings
from datetime import datetime
from typing import List, Dict, Optional, Tuple, Any
from dataclasses import dataclass

# --- Image Processing & Data Handling ---
import cv2
import numpy as np
from PIL import Image, ImageEnhance
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle

# --- Machine Learning & OCR ---
import torch
import easyocr
from transformers import TrOCRProcessor, VisionEncoderDecoderModel
import paddleocr

# --- Suppress Warnings ---
warnings.filterwarnings('ignore')

# ===================================================================
#   DATA STRUCTURES FOR BETTER ORGANIZATION
# ===================================================================
@dataclass
class ExtractedInfo:
    """Structure to hold all extracted information from driving license"""
    dl_numbers: List[str]
    name: Optional[str] = None
    father_name: Optional[str] = None
    address: Optional[str] = None
    dob: Optional[str] = None
    issue_date: Optional[str] = None
    valid_until: Optional[str] = None
    vehicle_classes: List[str] = None
    raw_text: str = ""
    confidence_scores: Dict[str, float] = None
    
    def __post_init__(self):
        if self.vehicle_classes is None:
            self.vehicle_classes = []
        if self.confidence_scores is None:
            self.confidence_scores = {}

# ===================================================================
#   STEP 1: ENHANCED IMAGE INPUT HANDLING
# ===================================================================
class DrivingLicenseImageInput:
    def __init__(self, filename: str):
        self.filename = filename
        self.supported_formats = ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.webp']
        self.min_resolution = (300, 200)  # Minimum width x height
        self.max_file_size = 10 * 1024 * 1024  # 10MB max file size
        
        self._validate_input()

    def _validate_input(self) -> None:
        """Comprehensive input validation"""
        if not os.path.exists(self.filename):
            raise FileNotFoundError(f"Image file not found: {self.filename}")

        file_ext = os.path.splitext(self.filename)[1].lower()
        if file_ext not in self.supported_formats:
            raise ValueError(f"Unsupported file format: {file_ext}. Use one of: {', '.join(self.supported_formats)}")
        
        file_size = os.path.getsize(self.filename)
        if file_size > self.max_file_size:
            raise ValueError(f"File size ({file_size/1024/1024:.1f}MB) exceeds maximum allowed size (10MB)")
        
        print(f"✅ Input validation passed for: {os.path.basename(self.filename)}")

    def load_image(self) -> np.ndarray:
        """Load and validate image with enhanced error handling"""
        try:
            # Try with OpenCV first
            image = cv2.imread(self.filename)
            if image is None:
                # Fallback to PIL
                pil_image = Image.open(self.filename)
                image = cv2.cvtColor(np.array(pil_image), cv2.COLOR_RGB2BGR)
            
            image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            h, w = image.shape[:2]
            
            if w < self.min_resolution[0] or h < self.min_resolution[1]:
                raise ValueError(f"Image resolution too low. Minimum required: {self.min_resolution[0]}x{self.min_resolution[1]}")
            
            print(f"✅ Loaded image: {os.path.basename(self.filename)}")
            print(f"   📐 Dimensions: {w}x{h} pixels")
            print(f"   📊 Channels: {image.shape[2] if len(image.shape) > 2 else 1}")
            
            return image
            
        except Exception as e:
            raise ValueError(f"Could not read image '{self.filename}': {str(e)}")

    def display_image(self, image: np.ndarray, title: str = "Uploaded Driving License", 
                     save_path: str = "original_image.png") -> None:
        """Enhanced image display with better visualization"""
        plt.figure(figsize=(12, 8))
        plt.imshow(image)
        plt.title(title, fontsize=16, fontweight='bold', pad=20)
        plt.axis('off')
        
        # Add image info as text
        h, w = image.shape[:2]
        plt.figtext(0.02, 0.02, f"Resolution: {w}x{h}", fontsize=10, 
                   bbox=dict(boxstyle="round,pad=0.3", facecolor="lightblue", alpha=0.7))
        
        plt.tight_layout()
        plt.savefig(save_path, dpi=150, bbox_inches='tight')
        print(f"✅ Saved image to {save_path}")

# ===================================================================
#   STEP 2: ENHANCED IMAGE PREPROCESSING
# ===================================================================
class DrivingLicensePreprocessor:
    def __init__(self):
        self.preprocessing_steps = []
    
    def enhance_contrast(self, image: np.ndarray) -> np.ndarray:
        """Apply adaptive contrast enhancement"""
        lab = cv2.cvtColor(image, cv2.COLOR_RGB2LAB)
        l_channel = lab[:, :, 0]
        
        # Apply CLAHE (Contrast Limited Adaptive Histogram Equalization)
        clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
        enhanced_l = clahe.apply(l_channel)
        
        lab[:, :, 0] = enhanced_l
        enhanced = cv2.cvtColor(lab, cv2.COLOR_LAB2RGB)
        return enhanced
    
    def reduce_noise(self, image: np.ndarray) -> np.ndarray:
        """Advanced noise reduction"""
        if len(image.shape) == 3:
            # Color image
            denoised = cv2.fastNlMeansDenoisingColored(image, None, 10, 10, 7, 21)
        else:
            # Grayscale
            denoised = cv2.fastNlMeansDenoising(image, None, 30, 7, 21)
        return denoised
    
    def sharpen_image(self, image: np.ndarray) -> np.ndarray:
        """Apply unsharp masking for better text clarity"""
        kernel = np.array([[-1,-1,-1],
                          [-1, 9,-1],
                          [-1,-1,-1]])
        sharpened = cv2.filter2D(image, -1, kernel)
        return sharpened
    
    def preprocess_image(self, image: np.ndarray, show_steps: bool = True) -> Tuple[np.ndarray, List[np.ndarray]]:
        """Enhanced preprocessing pipeline with multiple steps"""
        print("\n🔄 Starting enhanced image preprocessing pipeline...")
        
        steps = []
        step_names = []
        
        # Step 1: Original
        steps.append(image.copy())
        step_names.append("Original")
        
        # Step 2: Contrast Enhancement
        enhanced = self.enhance_contrast(image)
        steps.append(enhanced)
        step_names.append("Enhanced Contrast")
        
        # Step 3: Noise Reduction
        denoised = self.reduce_noise(enhanced)
        steps.append(denoised)
        step_names.append("Denoised")
        
        # Step 4: Sharpening
        sharpened = self.sharpen_image(denoised)
        steps.append(sharpened)
        step_names.append("Sharpened")
        
        # Step 5: Final grayscale conversion for better OCR
        gray = cv2.cvtColor(sharpened, cv2.COLOR_RGB2GRAY)
        final_processed = cv2.cvtColor(gray, cv2.COLOR_GRAY2RGB)
        steps.append(final_processed)
        step_names.append("Final Processed")
        
        if show_steps:
            self._visualize_preprocessing_steps(steps, step_names)
        
        print("✅ Preprocessing completed with enhanced pipeline.")
        return final_processed, steps
    
    def _visualize_preprocessing_steps(self, steps: List[np.ndarray], step_names: List[str]) -> None:
        """Visualize all preprocessing steps"""
        n_steps = len(steps)
        cols = min(3, n_steps)
        rows = (n_steps + cols - 1) // cols
        
        fig, axes = plt.subplots(rows, cols, figsize=(15, 5 * rows))
        if n_steps == 1:
            axes = [axes]
        elif rows == 1:
            axes = [axes] if cols == 1 else axes
        else:
            axes = axes.flatten()
        
        for i, (step_image, name) in enumerate(zip(steps, step_names)):
            if i < len(axes):
                axes[i].imshow(step_image, cmap='gray' if len(step_image.shape) == 2 else None)
                axes[i].set_title(name, fontweight='bold')
                axes[i].axis('off')
        
        # Hide extra subplots
        for i in range(n_steps, len(axes)):
            axes[i].axis('off')
        
        plt.tight_layout()
        plt.savefig("preprocessing_steps.png", dpi=150, bbox_inches='tight')
        print("✅ Saved preprocessing steps to preprocessing_steps.png")

# ===================================================================
#   STEPS 3, 4 & 5: ENHANCED OCR AND INFORMATION EXTRACTION
# ===================================================================
class AdvancedTextRecognizer:
    def __init__(self):
        self.device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
        self.trocr_processor = None
        self.trocr_model = None
        self.paddle_ocr = None
        self.easyocr_reader = None
        print(f"\n🧠 Advanced OCR will run on device: {self.device.type.upper()}")
        print(f"   🔧 CUDA available: {torch.cuda.is_available()}")

    def initialize_models(self) -> Dict[str, bool]:
        """Initialize all OCR models with error handling"""
        initialization_status = {}
        
        # Initialize EasyOCR
        try:
            print("🔄 Loading EasyOCR...")
            self.easyocr_reader = easyocr.Reader(['en'], gpu=torch.cuda.is_available())
            initialization_status['easyocr'] = True
            print("✅ EasyOCR loaded successfully.")
        except Exception as e:
            print(f"⚠️ EasyOCR load failed: {e}")
            initialization_status['easyocr'] = False

        # Initialize TrOCR
        try:
            print("🔄 Loading TrOCR...")
            model_name = "microsoft/trocr-base-printed"
            self.trocr_processor = TrOCRProcessor.from_pretrained(model_name)
            self.trocr_model = VisionEncoderDecoderModel.from_pretrained(model_name).to(self.device)
            initialization_status['trocr'] = True
            print("✅ TrOCR loaded successfully.")
        except Exception as e:
            print(f"⚠️ TrOCR load failed: {e}")
            initialization_status['trocr'] = False

        # Initialize PaddleOCR
        try:
            print("🔄 Loading PaddleOCR...")
            self.paddle_ocr = paddleocr.PaddleOCR(
                use_angle_cls=True, 
                lang='en', 
                use_gpu=torch.cuda.is_available(), 
                show_log=False
            )
            initialization_status['paddleocr'] = True
            print("✅ PaddleOCR loaded successfully.")
        except Exception as e:
            print(f"⚠️ PaddleOCR load failed: {e}")
            initialization_status['paddleocr'] = False
        
        loaded_count = sum(initialization_status.values())
        print(f"\n📊 Models loaded: {loaded_count}/3")
        return initialization_status

    def recognize_text_easyocr(self, image: np.ndarray) -> Tuple[str, List[Dict]]:
        """Enhanced EasyOCR text recognition with detailed results"""
        if self.easyocr_reader is None:
            return "", []
        
        print("🔍 Running EasyOCR...")
        results = self.easyocr_reader.readtext(image, detail=1)
        
        detailed_results = []
        texts = []
        
        for bbox, text, confidence in results:
            detailed_results.append({
                'text': text,
                'confidence': confidence,
                'bbox': bbox
            })
            texts.append(text)
            print(f"   📝 '{text}' (confidence: {confidence:.3f})")
        
        combined_text = " ".join(texts)
        print(f"✅ EasyOCR found {len(texts)} text regions.")
        return combined_text, detailed_results

    def recognize_text_trocr(self, image: np.ndarray) -> str:
        """TrOCR text recognition for high-quality results"""
        if self.trocr_processor is None or self.trocr_model is None:
            return ""
        
        print("🔍 Running TrOCR...")
        try:
            pil_image = Image.fromarray(image)
            pixel_values = self.trocr_processor(pil_image, return_tensors="pt").pixel_values.to(self.device)
            
            with torch.no_grad():
                generated_ids = self.trocr_model.generate(pixel_values)
            generated_text = self.trocr_processor.batch_decode(generated_ids, skip_special_tokens=True)[0]
            
            print(f"✅ TrOCR result: '{generated_text}'")
            return generated_text
            
        except Exception as e:
            print(f"⚠️ TrOCR processing error: {e}")
            return ""

    def recognize_text_paddle(self, image: np.ndarray) -> Tuple[str, List[Dict]]:
        """PaddleOCR text recognition with detailed results"""
        if self.paddle_ocr is None:
            return "", []
        
        print("🔍 Running PaddleOCR...")
        try:
            results = self.paddle_ocr.ocr(image, cls=True)
            
            detailed_results = []
            texts = []
            
            if results and results[0]:
                for line in results[0]:
                    if line:
                        bbox, (text, confidence) = line
                        detailed_results.append({
                            'text': text,
                            'confidence': confidence,
                            'bbox': bbox
                        })
                        texts.append(text)
                        print(f"   📝 '{text}' (confidence: {confidence:.3f})")
            
            combined_text = " ".join(texts)
            print(f"✅ PaddleOCR found {len(texts)} text regions.")
            return combined_text, detailed_results
            
        except Exception as e:
            print(f"⚠️ PaddleOCR processing error: {e}")
            return "", []

    def recognize_text(self, image: np.ndarray) -> Dict[str, Any]:
        """Comprehensive text recognition using all available OCR engines"""
        print("\n🎯 Starting comprehensive text recognition...")
        
        results = {
            'easyocr': {'text': '', 'details': []},
            'trocr': {'text': ''},
            'paddleocr': {'text': '', 'details': []},
            'combined_text': '',
            'best_text': ''
        }
        
        # Run EasyOCR
        easy_text, easy_details = self.recognize_text_easyocr(image)
        results['easyocr'] = {'text': easy_text, 'details': easy_details}
        
        # Run TrOCR
        trocr_text = self.recognize_text_trocr(image)
        results['trocr'] = {'text': trocr_text}
        
        # Run PaddleOCR
        paddle_text, paddle_details = self.recognize_text_paddle(image)
        results['paddleocr'] = {'text': paddle_text, 'details': paddle_details}
        
        # Combine results intelligently
        all_texts = [easy_text, trocr_text, paddle_text]
        results['combined_text'] = " ".join(filter(None, all_texts))
        
        # Choose best text based on length and content
        best_text = max(all_texts, key=len) if all_texts else ""
        results['best_text'] = best_text
        
        print(f"\n📊 Text Recognition Summary:")
        print(f"   🔤 EasyOCR: {len(easy_text)} chars")
        print(f"   🔤 TrOCR: {len(trocr_text)} chars")
        print(f"   🔤 PaddleOCR: {len(paddle_text)} chars")
        print(f"   🏆 Best result: {len(best_text)} chars")
        
        return results

# ===================================================================
#   ENHANCED INFORMATION EXTRACTION WITH MULTIPLE PATTERNS
# ===================================================================
class InformationExtractor:
    def __init__(self):
        self.state_codes = (
            "AN|AP|AR|AS|BR|CH|CT|DN|DD|DL|GA|GJ|HR|HP|JK|JH|KA|KL|LA|LD|MP|MH|"
            "MN|ML|MZ|NL|OD|PB|PY|RJ|SK|TN|TG|TR|UP|UT|WB"
        )
        self.vehicle_classes = ["LMV", "MCWG", "MCWOG", "TRANS", "HMV", "PSV", "LMV-NT", "FVG"]
        
    def extract_dl_numbers(self, text: str) -> List[str]:
        """Enhanced DL number extraction with multiple patterns"""
        print("\n🔍 Extracting DL numbers...")
        
        # Primary pattern: State code + 13 digits (total 15 chars)
        year_pattern = r"(19[5-9]\d|20[0-2]\d)"
        primary_pattern = rf"({self.state_codes})([\s-]?\d{{2}}[\s-]?{year_pattern}[\s-]?\d{{7}})"
        
        # Alternative patterns for edge cases
        alternative_patterns = [
            rf"({self.state_codes})\s*(\d{{13}})",  # State code + 13 digits
            rf"({self.state_codes})[\s-]*(\d{{2}})[\s-]*(\d{{4}})[\s-]*(\d{{7}})",  # Segmented format
        ]
        
        final_numbers = set()
        
        # Try primary pattern
        matches = re.findall(primary_pattern, text, re.IGNORECASE)
        for match in matches:
            state_part = match[0].upper()
            numeric_part = re.sub(r'\D', '', match[1])
            dl_number = f"{state_part}{numeric_part}"
            if len(dl_number) == 15:
                final_numbers.add(dl_number)
                print(f"   ✅ Found DL (primary): {dl_number}")
        
        # Try alternative patterns
        for pattern in alternative_patterns:
            matches = re.findall(pattern, text, re.IGNORECASE)
            for match in matches:
                if len(match) == 2:
                    state_part, numeric_part = match
                elif len(match) == 4:
                    state_part, part1, part2, part3 = match
                    numeric_part = part1 + part2 + part3
                else:
                    continue
                
                state_part = state_part.upper()
                numeric_part = re.sub(r'\D', '', numeric_part)
                dl_number = f"{state_part}{numeric_part}"
                
                if len(dl_number) == 15:
                    final_numbers.add(dl_number)
                    print(f"   ✅ Found DL (alternative): {dl_number}")
        
        return list(final_numbers)
    
    def extract_dates(self, text: str) -> Dict[str, Optional[str]]:
        """Extract various dates from the text"""
        dates = {'dob': None, 'issue_date': None, 'valid_until': None}
        
        # Common date patterns
        date_patterns = [
            r'\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b',  # DD/MM/YYYY or MM/DD/YYYY
            r'\b(\d{4})[/-](\d{1,2})[/-](\d{1,2})\b',  # YYYY/MM/DD
            r'\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\b'  # DD Mon YYYY
        ]
        
        found_dates = []
        for pattern in date_patterns:
            matches = re.findall(pattern, text, re.IGNORECASE)
            found_dates.extend(matches)
        
        # Simple heuristic assignment (would need more sophisticated logic for real use)
        if found_dates:
            dates['dob'] = f"{found_dates[0][0]}/{found_dates[0][1]}/{found_dates[0][2]}" if len(found_dates[0]) == 3 else None
        
        return dates
    
    def extract_name_info(self, text: str) -> Dict[str, Optional[str]]:
        """Extract name and father's name"""
        info = {'name': None, 'father_name': None}
        
        # Look for common patterns
        name_patterns = [
            r'Name[:\s]+([A-Za-z\s]+)',
            r'नाम[:\s]+([A-Za-z\s]+)',
        ]
        
        father_patterns = [
            r'Father[\'s]*\s*Name[:\s]+([A-Za-z\s]+)',
            r'S/O[:\s]+([A-Za-z\s]+)',
            r'पिता का नाम[:\s]+([A-Za-z\s]+)',
        ]
        
        for pattern in name_patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                info['name'] = match.group(1).strip()
                break
        
        for pattern in father_patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                info['father_name'] = match.group(1).strip()
                break
        
        return info
    
    def extract_vehicle_classes(self, text: str) -> List[str]:
        """Extract authorized vehicle classes"""
        found_classes = []
        for vehicle_class in self.vehicle_classes:
            if re.search(rf'\b{vehicle_class}\b', text, re.IGNORECASE):
                found_classes.append(vehicle_class)
        return found_classes
    
    def extract_all_info(self, ocr_results: Dict[str, Any]) -> ExtractedInfo:
        """Extract all information from OCR results"""
        print("\n📋 Extracting structured information...")
        
        # Use the best available text
        text = ocr_results.get('best_text', '') or ocr_results.get('combined_text', '')
        
        # Extract DL numbers
        dl_numbers = self.extract_dl_numbers(text)
        
        # Extract other information
        dates = self.extract_dates(text)
        name_info = self.extract_name_info(text)
        vehicle_classes = self.extract_vehicle_classes(text)
        
        # Calculate confidence scores (simplified)
        confidence_scores = {}
        if 'easyocr' in ocr_results and ocr_results['easyocr']['details']:
            avg_conf = np.mean([item['confidence'] for item in ocr_results['easyocr']['details']])
            confidence_scores['easyocr'] = float(avg_conf)
        
        extracted_info = ExtractedInfo(
            dl_numbers=dl_numbers,
            name=name_info.get('name'),
            father_name=name_info.get('father_name'),
            dob=dates.get('dob'),
            issue_date=dates.get('issue_date'),
            valid_until=dates.get('valid_until'),
            vehicle_classes=vehicle_classes,
            raw_text=text,
            confidence_scores=confidence_scores
        )
        
        print(f"✅ Information extraction completed:")
        print(f"   🆔 DL Numbers: {len(dl_numbers)} found")
        print(f"   👤 Name: {'✓' if extracted_info.name else '✗'}")
        print(f"   🚗 Vehicle Classes: {len(vehicle_classes)} found")
        
        return extracted_info

# ===================================================================
#   ENHANCED RESULTS EXPORT AND REPORTING
# ===================================================================
class ResultsExporter:
    def __init__(self, output_dir: str = "output"):
        self.output_dir = output_dir
        os.makedirs(output_dir, exist_ok=True)
    
    def save_to_json(self, extracted_info: ExtractedInfo, filename: str = "extracted_info.json") -> str:
        """Save extracted information to JSON file"""
        filepath = os.path.join(self.output_dir, filename)
        
        # Convert dataclass to dictionary
        info_dict = {
            'dl_numbers': extracted_info.dl_numbers,
            'name': extracted_info.name,
            'father_name': extracted_info.father_name,
            'address': extracted_info.address,
            'dob': extracted_info.dob,
            'issue_date': extracted_info.issue_date,
            'valid_until': extracted_info.valid_until,
            'vehicle_classes': extracted_info.vehicle_classes,
            'raw_text': extracted_info.raw_text,
            'confidence_scores': extracted_info.confidence_scores,
            'extraction_timestamp': datetime.now().isoformat()
        }
        
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(info_dict, f, indent=2, ensure_ascii=False)
        
        print(f"✅ Results saved to {filepath}")
        return filepath
    
    def generate_report(self, extracted_info: ExtractedInfo, filename: str = "extraction_report.txt") -> str:
        """Generate a detailed text report"""
        filepath = os.path.join(self.output_dir, filename)
        
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write("DRIVING LICENSE INFORMATION EXTRACTION REPORT\n")
            f.write("=" * 50 + "\n\n")
            f.write(f"Extraction Date: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n")
            
            f.write("EXTRACTED INFORMATION:\n")
            f.write("-" * 25 + "\n")
            f.write(f"DL Numbers: {', '.join(extracted_info.dl_numbers) if extracted_info.dl_numbers else 'None found'}\n")
            f.write(f"Name: {extracted_info.name or 'Not found'}\n")
            f.write(f"Father's Name: {extracted_info.father_name or 'Not found'}\n")
            f.write(f"Date of Birth: {extracted_info.dob or 'Not found'}\n")
            f.write(f"Issue Date: {extracted_info.issue_date or 'Not found'}\n")
            f.write(f"Valid Until: {extracted_info.valid_until or 'Not found'}\n")
            f.write(f"Vehicle Classes: {', '.join(extracted_info.vehicle_classes) if extracted_info.vehicle_classes else 'None found'}\n\n")
            
            if extracted_info.confidence_scores:
                f.write("CONFIDENCE SCORES:\n")
                f.write("-" * 18 + "\n")
                for engine, score in extracted_info.confidence_scores.items():
                    f.write(f"{engine.capitalize()}: {score:.3f}\n")
                f.write("\n")
            
            f.write("RAW EXTRACTED TEXT:\n")
            f.write("-" * 19 + "\n")
            f.write(extracted_info.raw_text)
        
        print(f"✅ Report saved to {filepath}")
        return filepath

# ===================================================================
#   MAIN EXECUTION FUNCTION WITH ENHANCED PIPELINE
# ===================================================================
def main_pipeline(image_path: str = "sample_dl.jpg", save_results: bool = True) -> ExtractedInfo:
    """Enhanced main pipeline with comprehensive processing"""
    print("=" * 60)
    print("  ENHANCED DRIVING LICENSE PROCESSING PIPELINE")
    print("=" * 60)
    
    start_time = datetime.now()
    
    try:
        # Step 1: Image Input with validation
        print("\n📂 STEP 1: Image Input and Validation")
        input_handler = DrivingLicenseImageInput(image_path)
        image = input_handler.load_image()
        input_handler.display_image(image, "Original Driving License")

        # Step 2: Enhanced Preprocessing
        print("\n🔧 STEP 2: Enhanced Image Preprocessing")
        preprocessor = DrivingLicensePreprocessor()
        processed_image, processing_steps = preprocessor.preprocess_image(image, show_steps=True)

        # Step 3-5: Advanced OCR with multiple engines
        print("\n🤖 STEP 3-5: Advanced OCR and Text Recognition")
        recognizer = AdvancedTextRecognizer()
        model_status = recognizer.initialize_models()
        ocr_results = recognizer.recognize_text(processed_image)

        # Step 6: Information Extraction
        print("\n📊 STEP 6: Information Extraction and Structuring")
        extractor = InformationExtractor()
        extracted_info = extractor.extract_all_info(ocr_results)

        # Step 7: Results Export and Reporting
        if save_results:
            print("\n💾 STEP 7: Results Export and Reporting")
            exporter = ResultsExporter()
            json_file = exporter.save_to_json(extracted_info)
            report_file = exporter.generate_report(extracted_info)

        # Final Summary
        end_time = datetime.now()
        processing_time = (end_time - start_time).total_seconds()
        
        print("\n" + "=" * 60)
        print("  🎉 PIPELINE EXECUTION COMPLETED SUCCESSFULLY!")
        print("=" * 60)
        print(f"📊 Processing Summary:")
        print(f"   ⏱️  Total Processing Time: {processing_time:.2f} seconds")
        print(f"   📋 OCR Engines Used: {sum(model_status.values())}/3")
        print(f"   🆔 DL Numbers Found: {len(extracted_info.dl_numbers)}")
        print(f"   🔤 Total Characters Extracted: {len(extracted_info.raw_text)}")
        
        if extracted_info.dl_numbers:
            print(f"\n🔑 EXTRACTED DL NUMBERS:")
            for i, dl_num in enumerate(extracted_info.dl_numbers, 1):
                print(f"   {i}. {dl_num}")
        else:
            print("\n⚠️  No valid DL numbers found in the image")
        
        if extracted_info.confidence_scores:
            avg_confidence = np.mean(list(extracted_info.confidence_scores.values()))
            print(f"\n📈 Average OCR Confidence: {avg_confidence:.3f}")
        
        return extracted_info

    except FileNotFoundError as e:
        print(f"\n❌ File Error: {e}")
        print("💡 Please ensure the image file exists and try again.")
        return None
        
    except ValueError as e:
        print(f"\n❌ Input Error: {e}")
        print("💡 Please check your image format and quality.")
        return None
        
    except Exception as e:
        print(f"\n❌ Unexpected Error: {e}")
        print("💡 Please check your environment setup and dependencies.")
        return None

# ===================================================================
#   BATCH PROCESSING CAPABILITY
# ===================================================================
def batch_process_licenses(image_directory: str, output_directory: str = "batch_output") -> List[ExtractedInfo]:
    """Process multiple driving license images in batch"""
    print(f"\n🔄 Starting batch processing from directory: {image_directory}")
    
    if not os.path.exists(image_directory):
        raise FileNotFoundError(f"Directory not found: {image_directory}")
    
    # Create output directory
    os.makedirs(output_directory, exist_ok=True)
    
    # Find all image files
    supported_extensions = ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.webp']
    image_files = []
    
    for filename in os.listdir(image_directory):
        if any(filename.lower().endswith(ext) for ext in supported_extensions):
            image_files.append(os.path.join(image_directory, filename))
    
    if not image_files:
        print("⚠️  No supported image files found in the directory")
        return []
    
    print(f"📁 Found {len(image_files)} image files to process")
    
    # Process each image
    results = []
    successful_extractions = 0
    
    for i, image_path in enumerate(image_files, 1):
        print(f"\n" + "="*50)
        print(f"Processing {i}/{len(image_files)}: {os.path.basename(image_path)}")
        print("="*50)
        
        try:
            # Create individual output directory for this image
            image_name = os.path.splitext(os.path.basename(image_path))[0]
            individual_output = os.path.join(output_directory, f"result_{image_name}")
            os.makedirs(individual_output, exist_ok=True)
            
            # Process the image
            extracted_info = main_pipeline(image_path, save_results=False)
            
            if extracted_info:
                # Save results in individual directory
                exporter = ResultsExporter(individual_output)
                exporter.save_to_json(extracted_info, f"{image_name}_info.json")
                exporter.generate_report(extracted_info, f"{image_name}_report.txt")
                
                results.append(extracted_info)
                if extracted_info.dl_numbers:
                    successful_extractions += 1
                
        except Exception as e:
            print(f"❌ Failed to process {image_path}: {e}")
            continue
    
    # Generate batch summary
    batch_summary_path = os.path.join(output_directory, "batch_summary.json")
    batch_summary = {
        'total_images': len(image_files),
        'successful_processes': len(results),
        'successful_extractions': successful_extractions,
        'processing_timestamp': datetime.now().isoformat(),
        'results': []
    }
    
    for i, result in enumerate(results):
        batch_summary['results'].append({
            'image_index': i + 1,
            'dl_numbers_found': len(result.dl_numbers),
            'dl_numbers': result.dl_numbers,
            'has_name': bool(result.name),
            'vehicle_classes_count': len(result.vehicle_classes)
        })
    
    with open(batch_summary_path, 'w') as f:
        json.dump(batch_summary, f, indent=2)
    
    print(f"\n" + "="*60)
    print("  🎯 BATCH PROCESSING COMPLETED")
    print("="*60)
    print(f"📊 Batch Summary:")
    print(f"   📁 Total Images: {len(image_files)}")
    print(f"   ✅ Successfully Processed: {len(results)}")
    print(f"   🆔 Successful DL Extractions: {successful_extractions}")
    print(f"   📈 Success Rate: {(successful_extractions/len(image_files)*100):.1f}%")
    print(f"   💾 Results saved to: {output_directory}")
    
    return results

# ===================================================================
#   PERFORMANCE BENCHMARKING
# ===================================================================
def benchmark_ocr_engines(image_path: str) -> Dict[str, Any]:
    """Benchmark different OCR engines for performance comparison"""
    print("\n🏃 Running OCR Engine Benchmark...")
    
    # Load and preprocess image
    input_handler = DrivingLicenseImageInput(image_path)
    image = input_handler.load_image()
    preprocessor = DrivingLicensePreprocessor()
    processed_image, _ = preprocessor.preprocess_image(image, show_steps=False)
    
    # Initialize recognizer
    recognizer = AdvancedTextRecognizer()
    model_status = recognizer.initialize_models()
    
    benchmark_results = {
        'image_path': image_path,
        'image_dimensions': image.shape,
        'engines': {}
    }
    
    # Benchmark EasyOCR
    if model_status.get('easyocr', False):
        start_time = datetime.now()
        easy_text, easy_details = recognizer.recognize_text_easyocr(processed_image)
        easy_time = (datetime.now() - start_time).total_seconds()
        
        benchmark_results['engines']['easyocr'] = {
            'processing_time': easy_time,
            'characters_extracted': len(easy_text),
            'regions_detected': len(easy_details),
            'average_confidence': np.mean([d['confidence'] for d in easy_details]) if easy_details else 0
        }
    
    # Benchmark TrOCR
    if model_status.get('trocr', False):
        start_time = datetime.now()
        trocr_text = recognizer.recognize_text_trocr(processed_image)
        trocr_time = (datetime.now() - start_time).total_seconds()
        
        benchmark_results['engines']['trocr'] = {
            'processing_time': trocr_time,
            'characters_extracted': len(trocr_text)
        }
    
    # Benchmark PaddleOCR
    if model_status.get('paddleocr', False):
        start_time = datetime.now()
        paddle_text, paddle_details = recognizer.recognize_text_paddle(processed_image)
        paddle_time = (datetime.now() - start_time).total_seconds()
        
        benchmark_results['engines']['paddleocr'] = {
            'processing_time': paddle_time,
            'characters_extracted': len(paddle_text),
            'regions_detected': len(paddle_details),
            'average_confidence': np.mean([d['confidence'] for d in paddle_details]) if paddle_details else 0
        }
    
    # Print benchmark results
    print("\n📊 OCR Engine Benchmark Results:")
    print("-" * 40)
    for engine, results in benchmark_results['engines'].items():
        print(f"{engine.upper()}:")
        print(f"  ⏱️  Processing Time: {results['processing_time']:.3f}s")
        print(f"  🔤 Characters: {results['characters_extracted']}")
        if 'regions_detected' in results:
            print(f"  📍 Regions: {results['regions_detected']}")
        if 'average_confidence' in results:
            print(f"  📈 Avg Confidence: {results['average_confidence']:.3f}")
        print()
    
    return benchmark_results

# ===================================================================
#   INTERACTIVE MODE WITH USER FEEDBACK
# ===================================================================
def interactive_mode():
    """Run the pipeline in interactive mode with user choices"""
    print("\n🎮 INTERACTIVE DRIVING LICENSE PROCESSOR")
    print("=" * 45)
    
    while True:
        print("\nChoose an option:")
        print("1. Process single image")
        print("2. Batch process directory")
        print("3. Benchmark OCR engines")
        print("4. Exit")
        
        choice = input("\nEnter your choice (1-4): ").strip()
        
        if choice == '1':
            image_path = input("Enter image path: ").strip()
            if os.path.exists(image_path):
                result = main_pipeline(image_path)
                if result and result.dl_numbers:
                    print(f"\n✅ Successfully extracted {len(result.dl_numbers)} DL number(s)")
            else:
                print("❌ Image file not found!")
                
        elif choice == '2':
            directory = input("Enter directory path: ").strip()
            if os.path.exists(directory):
                output_dir = input("Enter output directory (press Enter for default): ").strip()
                if not output_dir:
                    output_dir = "batch_output"
                batch_process_licenses(directory, output_dir)
            else:
                print("❌ Directory not found!")
                
        elif choice == '3':
            image_path = input("Enter image path for benchmarking: ").strip()
            if os.path.exists(image_path):
                benchmark_ocr_engines(image_path)
            else:
                print("❌ Image file not found!")
                
        elif choice == '4':
            print("👋 Goodbye!")
            break
            
        else:
            print("❌ Invalid choice! Please enter 1-4.")

# ===================================================================
#   EXAMPLE USAGE AND MAIN EXECUTION
# ===================================================================
if __name__ == "__main__":
    import sys
    
    # Check if running with arguments
    if len(sys.argv) > 1:
        if sys.argv[1] == "--interactive":
            interactive_mode()
        elif sys.argv[1] == "--batch":
            if len(sys.argv) > 2:
                directory = sys.argv[2]
                output_dir = sys.argv[3] if len(sys.argv) > 3 else "batch_output"
                batch_process_licenses(directory, output_dir)
            else:
                print("Usage: python script.py --batch <input_directory> [output_directory]")
        elif sys.argv[1] == "--benchmark":
            if len(sys.argv) > 2:
                benchmark_ocr_engines(sys.argv[2])
            else:
                print("Usage: python script.py --benchmark <image_path>")
        else:
            # Single image processing
            main_pipeline(sys.argv[1])
    else:
        # Default: process test image or run interactive mode
        test_image = "test_license_3.jpg"
        if os.path.exists(test_image):
            print("🔍 Found test image, processing...")
            main_pipeline(test_image)
        else:
            print("ℹ️  No test image found. Starting interactive mode...")
            interactive_mode()