import requests
import base64
import json

# --- CONFIG ---
SHOPIFY_STORE = "83bfa8-c4.myshopify.com"
SHOPIFY_TOKEN = "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"
BITRIX_WEBHOOK = "https://bfcshoes.bitrix24.eu/rest/52/zrbhiktlam8mz1yr/"

TARGET_BX_ID = 10338
TARGET_VARIANT_ID = "53114069156104"

def get_shopify_image_base64(variant_id):
    try:
        print(f"Fetching Shopify Variant {variant_id}...")
        v_url = f"https://{SHOPIFY_STORE}/admin/api/2024-01/variants/{variant_id}.json"
        v_resp = requests.get(v_url, headers={"X-Shopify-Access-Token": SHOPIFY_TOKEN})
        if not v_resp.ok:
            print("Error fetching variant:", v_resp.text)
            return None
        
        v_data = v_resp.json()
        variant = v_data.get("variant")
        if not variant or not variant.get("image_id"):
            print("No image_id in variant.")
            return None
            
        print(f"Fetching Product {variant['product_id']} Image {variant['image_id']}...")
        p_url = f"https://{SHOPIFY_STORE}/admin/api/2024-01/products/{variant['product_id']}/images/{variant['image_id']}.json"
        p_resp = requests.get(p_url, headers={"X-Shopify-Access-Token": SHOPIFY_TOKEN})
        if not p_resp.ok: return None
        
        img_url = p_resp.json().get("image", {}).get("src")
        if not img_url: return None
        
        print(f"Downloading Image: {img_url}")
        img_resp = requests.get(img_url)
        if not img_resp.ok: return None
        
        return base64.b64encode(img_resp.content).decode('utf-8')
    except Exception as e:
        print(f"Error fetching image: {e}")
        return None

def get_shopify_description(variant_id):
    try:
        v_url = f"https://{SHOPIFY_STORE}/admin/api/2024-01/variants/{variant_id}.json"
        v_resp = requests.get(v_url, headers={"X-Shopify-Access-Token": SHOPIFY_TOKEN})
        if not v_resp.ok: return None
        
        product_id = v_resp.json().get("variant", {}).get("product_id")
        if not product_id: return None
        
        print(f"Fetching Product {product_id} Description...")
        p_url = f"https://{SHOPIFY_STORE}/admin/api/2024-01/products/{product_id}.json"
        p_resp = requests.get(p_url, headers={"X-Shopify-Access-Token": SHOPIFY_TOKEN})
        
        return p_resp.json().get("product", {}).get("body_html", "")
    except Exception as e:
        print(f"Error fetching description: {e}")
        return None

def update_bitrix(bx_id, image_b64, description):
    fields = {}
    if image_b64:
        fields["PREVIEW_PICTURE"] = {"fileData": ["image.jpg", image_b64]}
        fields["DETAIL_PICTURE"] = {"fileData": ["image.jpg", image_b64]}
    
    if description:
        fields["DETAIL_TEXT"] = description
        fields["DETAIL_TEXT_TYPE"] = "html"
        fields["PREVIEW_TEXT"] = description
        fields["PREVIEW_TEXT_TYPE"] = "html"
        fields["DESCRIPTION"] = description
        fields["DESCRIPTION_TYPE"] = "html"
    
    if not fields:
        print("Nothing to update.")
        return

    print(f"Updating Bitrix Product {bx_id}...")
    res = requests.post(f"{BITRIX_WEBHOOK}crm.product.update", json={"id": bx_id, "fields": fields})
    print("Result:", res.json())

def main():
    img_b64 = get_shopify_image_base64(TARGET_VARIANT_ID)
    desc = get_shopify_description(TARGET_VARIANT_ID)
    
    if img_b64 or desc:
        update_bitrix(TARGET_BX_ID, img_b64, desc)
    else:
        print("Could not fetch data.")

if __name__ == "__main__":
    main()
