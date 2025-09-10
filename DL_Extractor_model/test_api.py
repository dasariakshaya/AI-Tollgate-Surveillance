import requests

API_URL = "https://my-ml-api-995937866035.us-central1.run.app"
IMAGE_PATH = r"C:\Users\AKSHAYA DASARI\Downloads\data_license\number_plate\number_plate-7.jpg"

def test_local_api(image_path, api_url):
    try:
        with open(image_path, "rb") as img:
            files = {"dl_image": img}
            response = requests.post(api_url, files=files)

        print("Status Code:", response.status_code)
        try:
            print("Response JSON:", response.json())
        except Exception:
            print("Response Text:", response.text)

    except FileNotFoundError:
        print(f"❌ Image not found: {image_path}")
    except requests.exceptions.RequestException as e:
        print(f"❌ Request failed: {e}")

if __name__ == "__main__":
    test_local_api(IMAGE_PATH, API_URL)
