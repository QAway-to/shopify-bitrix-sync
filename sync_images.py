"""
Image Sync Script - Uploads Shopify product images to Bitrix by Section
Updated: Added Session management, Retries and Error Handling
"""
import requests
import base64
import sys
import time
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

SHOPIFY_STORE = "83bfa8-c4.myshopify.com"
SHOPIFY_TOKEN = "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"
BITRIX_WEBHOOK = "https://bfcshoes.bitrix24.eu/rest/52/zrbhiktlam8mz1yr/"

SECTIONS = {
    36: "A-F",
    38: "G-M",
    40: "N-S",
    42: "T-Z"
}

# --- НАСТРОЙКА СЕССИИ С ПОВТОРАМИ ---
def create_session():
    session = requests.Session()
    retry_strategy = Retry(
        total=5, # Общее количество попыток
        backoff_factor=2, # Пауза между попытками: 2с, 4с, 8с...
        status_forcelist=[429, 500, 502, 503, 504], # Повторять при этих статусах
        raise_on_status=False
    )
    adapter = HTTPAdapter(max_retries=retry_strategy)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session

session = create_session()
# ------------------------------------

def fetch_bitrix_products(section_id):
    print(f"\n[BITRIX] Fetching Section {section_id} ({SECTIONS.get(section_id, 'Unknown')})...")
    products = {}
    start = 0
    while True:
        try:
            resp = session.post(f"{BITRIX_WEBHOOK}crm.product.list", json={
                "filter": {"SECTION_ID": section_id},
                "select": ["ID", "NAME", "XML_ID", "PREVIEW_PICTURE", "DETAIL_PICTURE"],
                "start": start
            }, timeout=30).json()

            items = resp.get("result", [])
            if not items: break
            for item in items:
                if item.get("XML_ID"):
                    products[item["XML_ID"]] = item
            if len(items) < 50: break
            start = resp.get("next")
            if not start: break
        except Exception as e:
            print(f"  [!] Error fetching products: {e}")
            break

    print(f"[BITRIX] Found {len(products)} products")
    return products

def get_shopify_image(variant_id):
    """Get variant/product image from Shopify"""
    try:
        headers = {"X-Shopify-Access-Token": SHOPIFY_TOKEN}

        # Get variant
        v_url = f"https://{SHOPIFY_STORE}/admin/api/2024-01/variants/{variant_id}.json"
        v_resp = session.get(v_url, headers=headers, timeout=30)
        if not v_resp.ok: return None

        variant = v_resp.json().get("variant", {})
        product_id = variant.get("product_id")
        image_id = variant.get("image_id")

        if not product_id: return None

        # Get product
        p_url = f"https://{SHOPIFY_STORE}/admin/api/2024-01/products/{product_id}.json"
        p_resp = session.get(p_url, headers=headers, timeout=30)
        if not p_resp.ok: return None

        product = p_resp.json().get("product", {})
        images = product.get("images", [])

        if not images: return None

        image_src = None
        if image_id:
            for img in images:
                if img.get("id") == image_id:
                    image_src = img.get("src")
                    break

        if not image_src:
            image_src = images[0].get("src")

        if not image_src: return None

        # Download image
        img_resp = session.get(image_src, timeout=60)
        if img_resp.ok:
            img_base64 = base64.b64encode(img_resp.content).decode('utf-8')
            ext = "jpg"
            if ".png" in image_src.lower(): ext = "png"
            elif ".webp" in image_src.lower(): ext = "webp"

            return {
                "base64": img_base64,
                "filename": f"product_{variant_id}.{ext}"
            }
        return None
    except Exception as e:
        print(f"  ERR Shopify Image ({variant_id}): {e}")
        return None

def sync_images_for_section(section_id, skip_existing=True):
    products = fetch_bitrix_products(section_id)

    print(f"\n[SYNC] Syncing images for {len(products)} products...")

    uploaded = 0
    skipped = 0
    errors = 0

    for i, (xml_id, prod) in enumerate(products.items()):
        # Skip if already has images
        if skip_existing and prod.get("PREVIEW_PICTURE"):
            skipped += 1
            continue

        try:
            img = get_shopify_image(xml_id)
            if img:
                # Upload to Bitrix
                resp = session.post(f"{BITRIX_WEBHOOK}crm.product.update", json={
                    "id": prod["ID"],
                    "fields": {
                        "PREVIEW_PICTURE": {
                            "fileData": [img["filename"], img["base64"]]
                        },
                        "DETAIL_PICTURE": {
                            "fileData": [img["filename"], img["base64"]]
                        }
                    }
                }, timeout=60)

                if resp.status_code == 200:
                    uploaded += 1
                else:
                    print(f"  [!] Failed to update Bitrix ID {prod['ID']}: {resp.text}")
                    errors += 1
            else:
                skipped += 1

        except Exception as e:
            print(f"  [!] Critical error on product {xml_id} (Bitrix ID: {prod['ID']}): {e}")
            errors += 1
            time.sleep(2) # Пауза при ошибке, чтобы сервер "остыл"

        if (i+1) % 10 == 0:
            print(f"  Progress: {i+1}/{len(products)} (Uploaded: {uploaded}, Skipped: {skipped}, Errors: {errors})")

        # Rate limit - Bitrix Cloud любит паузы
        time.sleep(0.3)

    print(f"\nOK Section {section_id} ({SECTIONS.get(section_id)}): Uploaded {uploaded}, Skipped {skipped}, Errors {errors}")
    return uploaded

if __name__ == "__main__":
    TARGET_SECTIONS = [38]

    if len(sys.argv) > 1:
        arg = sys.argv[1]
        if arg == "all": TARGET_SECTIONS = "all"
        else: TARGET_SECTIONS = [int(arg)]

    print(f"Starting Image Sync for: {TARGET_SECTIONS}")

    if TARGET_SECTIONS == "all":
        sections_to_run = [36, 38, 40, 42]
    elif isinstance(TARGET_SECTIONS, list):
        sections_to_run = TARGET_SECTIONS
    else:
        sections_to_run = [TARGET_SECTIONS]

    total_uploaded = 0
    for section_id in sections_to_run:
        if section_id not in SECTIONS:
            print(f"[WARN] Invalid section ID: {section_id}")
            continue
        total_uploaded += sync_images_for_section(section_id)

    print(f"\n=== FINISHED. Total images uploaded: {total_uploaded} ===")