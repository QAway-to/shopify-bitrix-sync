"""
Image Sync Script - Uploads Shopify product images to Bitrix by Section
Usage: python sync_images.py [section]
  section: 36 (A-F), 38 (G-M), 40 (N-S), 42 (T-Z)
"""
import requests
import base64
import sys
import time

SHOPIFY_STORE = "83bfa8-c4.myshopify.com"
SHOPIFY_TOKEN = "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"
BITRIX_WEBHOOK = "https://bfcshoes.bitrix24.eu/rest/52/zrbhiktlam8mz1yr/"

SECTIONS = {
    36: "A-F",
    38: "G-M", 
    40: "N-S",
    42: "T-Z"
}

def fetch_bitrix_products(section_id):
    print(f"\n[BITRIX] Fetching Section {section_id} ({SECTIONS.get(section_id, 'Unknown')})...")
    products = {}
    start = 0
    while True:
        resp = requests.post(f"{BITRIX_WEBHOOK}crm.product.list", json={
            "filter": {"SECTION_ID": section_id},
            "select": ["ID", "NAME", "XML_ID", "PREVIEW_PICTURE", "DETAIL_PICTURE"],
            "start": start
        }).json()
        items = resp.get("result", [])
        if not items: break
        for item in items:
            if item.get("XML_ID"):
                products[item["XML_ID"]] = item
        if len(items) < 50: break
        start = resp.get("next")
        if not start: break
    print(f"[BITRIX] Found {len(products)} products")
    return products

def get_shopify_image(variant_id):
    """Get variant/product image from Shopify"""
    try:
        # Get variant to find product_id
        v_url = f"https://{SHOPIFY_STORE}/admin/api/2024-01/variants/{variant_id}.json"
        v_resp = requests.get(v_url, headers={"X-Shopify-Access-Token": SHOPIFY_TOKEN})
        if not v_resp.ok: return None
        
        variant = v_resp.json().get("variant", {})
        product_id = variant.get("product_id")
        image_id = variant.get("image_id")
        
        if not product_id: return None
        
        # Get product to find images
        p_url = f"https://{SHOPIFY_STORE}/admin/api/2024-01/products/{product_id}.json"
        p_resp = requests.get(p_url, headers={"X-Shopify-Access-Token": SHOPIFY_TOKEN})
        if not p_resp.ok: return None
        
        product = p_resp.json().get("product", {})
        images = product.get("images", [])
        
        if not images: return None
        
        # Try variant-specific image first, otherwise use first image
        image_src = None
        if image_id:
            for img in images:
                if img.get("id") == image_id:
                    image_src = img.get("src")
                    break
        
        if not image_src:
            image_src = images[0].get("src")
        
        if not image_src: return None
        
        # Download image and encode to base64
        img_resp = requests.get(image_src)
        if img_resp.ok:
            img_base64 = base64.b64encode(img_resp.content).decode('utf-8')
            # Determine file extension
            ext = "jpg"
            if ".png" in image_src.lower(): ext = "png"
            elif ".webp" in image_src.lower(): ext = "webp"
            
            return {
                "base64": img_base64,
                "filename": f"product_{variant_id}.{ext}"
            }
        return None
    except Exception as e:
        print(f"  ERR Image: {e}")
        return None

def sync_images_for_section(section_id, skip_existing=True):
    products = fetch_bitrix_products(section_id)
    
    print(f"\n[SYNC] Syncing images for {len(products)} products...")
    
    uploaded = 0
    skipped = 0
    
    for i, (xml_id, prod) in enumerate(products.items()):
        # Skip if already has images
        if skip_existing and prod.get("PREVIEW_PICTURE"):
            skipped += 1
            continue
        
        img = get_shopify_image(xml_id)
        if img:
            # Upload to Bitrix
            resp = requests.post(f"{BITRIX_WEBHOOK}crm.product.update", json={
                "id": prod["ID"],
                "fields": {
                    "PREVIEW_PICTURE": {
                        "fileData": [img["filename"], img["base64"]]
                    },
                    "DETAIL_PICTURE": {
                        "fileData": [img["filename"], img["base64"]]
                    }
                }
            })
            uploaded += 1
        
        if (i+1) % 10 == 0:
            print(f"  Progress: {i+1}/{len(products)} (Uploaded: {uploaded}, Skipped: {skipped})")
        
        # Rate limit
        time.sleep(0.2)
    
    print(f"\nOK Section {section_id} ({SECTIONS.get(section_id)}): Uploaded {uploaded}, Skipped {skipped}")
    return uploaded

def main():
    if len(sys.argv) < 2:
        print("Usage: python sync_images.py [section]")
        print("  Sections: 36 (A-F), 38 (G-M), 40 (N-S), 42 (T-Z)")
        print("  Or 'all' to sync all sections")
        return
    
    arg = sys.argv[1]
    
    if arg == "all":
        total = 0
        for section_id in [36, 38, 40, 42]:
            total += sync_images_for_section(section_id)
        print(f"\n=== TOTAL: Uploaded {total} images across all sections ===")
    else:
        section_id = int(arg)
        if section_id not in SECTIONS:
            print(f"Invalid section: {section_id}")
            return
        sync_images_for_section(section_id)

if __name__ == "__main__":
    main()
