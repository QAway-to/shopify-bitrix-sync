"""
Sync Certificates with Images Script (Based on Batch Sync)
- Fetches all products (Certificates are assumed to be identified by Section 32 in Bitrix or specific logic)
- For this script, we will fetch ALL variants from Shopify, and FILTER only those that map to Section 32 (Certificates).
- Then update them in Bitrix, INCLUDING IMAGES.
"""

import requests
import json
import time
import sys
import codecs
import base64
from typing import Dict, List, Optional, Tuple

# ============ CREDENTIALS ============
SHOPIFY_STORE = "83bfa8-c4.myshopify.com"
SHOPIFY_TOKEN = "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"
BITRIX_WEBHOOK = "https://bfcshoes.bitrix24.eu/rest/52/zrbhiktlam8mz1yr/"
TARGET_SECTION_ID = 32

# ============ SHOPIFY API (With Image Fetching) ============
def get_shopify_image_base64(variant_id: str, product_id: str = None, image_id: str = None) -> Optional[str]:
    """Fetch Shopify variant image and return as Base64 string"""
    try:
        # If we don't have image_id, fetch variant to get it
        if not image_id or not product_id:
            v_url = f"https://{SHOPIFY_STORE}/admin/api/2024-01/variants/{variant_id}.json"
            v_resp = requests.get(v_url, headers={"X-Shopify-Access-Token": SHOPIFY_TOKEN})
            if not v_resp.ok: return None
            v_data = v_resp.json().get("variant")
            if not v_data or not v_data.get("image_id"): return None
            product_id = v_data.get("product_id")
            image_id = v_data.get("image_id")

        # Fetch Image Source
        p_url = f"https://{SHOPIFY_STORE}/admin/api/2024-01/products/{product_id}/images/{image_id}.json"
        p_resp = requests.get(p_url, headers={"X-Shopify-Access-Token": SHOPIFY_TOKEN})
        if not p_resp.ok: return None
        
        img_src = p_resp.json().get("image", {}).get("src")
        if not img_src: return None

        # Download and Base64 Encode
        img_resp = requests.get(img_src)
        if not img_resp.ok: return None
        
        return base64.b64encode(img_resp.content).decode('utf-8')
    except Exception as e:
        print(f"[IMG] Error fetching image for {variant_id}: {e}")
        return None

def fetch_shopify_products() -> List[Dict]:
    """Fetch ALL products from Shopify"""
    all_variants = []
    print("\n[SHOPIFY] Fetching all products...")
    
    products_to_process = []
    page_info = None
    has_next = True
    
    while has_next:
        url = f"https://{SHOPIFY_STORE}/admin/api/2024-01/products.json?limit=250"
        if page_info: url += f"&page_info={page_info}"
        
        response = requests.get(url, headers={"X-Shopify-Access-Token": SHOPIFY_TOKEN})
        if response.status_code != 200: break
        
        data = response.json()
        products_to_process.extend(data.get("products", []))
        
        link_header = response.headers.get("Link", "")
        has_next = False
        if 'rel="next"' in link_header:
            try:
                page_info = link_header.split('page_info=')[1].split('>')[0]
                has_next = True
            except: pass

    print(f"[SHOPIFY] Processing {len(products_to_process)} products...")
    
    for product in products_to_process:
        # Filter logic: How do we know it's a certificate?
        # User said "All in Section 32". 
        # But here we are fetching from Shopify. We don't know the Bitrix Section yet.
        # We will assume "Gift Card" type or specific logic.
        # OR we just return ALL variants, and filter by Bitrix Section later (checking existence).
        # But if we need to CREATE them, we need to know if they belong to Section 32.
        
        # Assumption: "Gift Card" product type in Shopify maps to Certificates?
        # Or checking title?
        p_type = product.get("product_type", "").lower()
        title = product.get("title", "").lower()
        
        is_certificate = "gift card" in p_type or "certificate" in title or "voucher" in title
        
        # NOTE: If we only want to UPDATE existing Bitrix products in Section 32,
        # we can fetch ALL Bitrix products in Section 32 first, get their XML_IDs,
        # and then only process those specific variants from Shopify.
        # This is safer.
        pass

        for variant in product.get("variants", []):
            all_variants.append({
                "product_id": product["id"],
                "variant_id": str(variant["id"]),
                "title": product["title"],
                "price": float(variant.get("price", 0)),
                "sku": variant.get("sku", ""),
                "image_id": variant.get("image_id") # Opt
            })
            
    print(f"[SHOPIFY] Fetched {len(all_variants)} total variants")
    return all_variants

# ============ BITRIX API ============
def call_batch(commands, halt=False):
    res = requests.post(f"{BITRIX_WEBHOOK}batch", json={"halt": 1 if halt else 0, "cmd": commands})
    return res.json()

def execute_batches(commands, batch_size=50):
    total = len(commands)
    print(f"[BATCH] Executing {total} commands...")
    for i in range(0, total, batch_size):
        chunk = commands[i:i+batch_size]
        batch_cmd = {f"cmd_{j}": cmd for j, (key, cmd) in enumerate(chunk)}
        try:
            call_batch(batch_cmd)
        except Exception as e:
            print(f"  ERR Batch failed: {e}")
        print(f"  Processed {min(i+batch_size, total)}/{total}")
        time.sleep(0.5)

def fetch_bitrix_certificates():
    """Fetch all products in Section 32"""
    print(f"\n[BITRIX] Fetching products in Section {TARGET_SECTION_ID}...")
    products = {}
    start = 0
    while True:
        resp = requests.post(f"{BITRIX_WEBHOOK}crm.product.list", json={
            "order": {"ID": "ASC"},
            "filter": {"SECTION_ID": TARGET_SECTION_ID},
            "select": ["ID", "NAME", "XML_ID", "PRICE", "PREVIEW_PICTURE"],
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
        
    print(f"[BITRIX] Found {len(products)} certificates in Section {TARGET_SECTION_ID}")
    return products

# ============ SYNC ============
def run_sync():
    # 1. Get Target Bitrix Products (Section 32)
    bx_certs = fetch_bitrix_certificates()
    if not bx_certs:
        print("[SYNC] No certificates found in Bitrix Section 32.")
        return

    # 2. Get ALL Shopify Products (to find matches)
    all_variants = fetch_shopify_products()
    
    # Filter for potential certificates in Shopify
    shopify_certs = []
    for v in all_variants:
        title_lower = v["title"].lower()
        if "gift" in title_lower or "certificate" in title_lower or "voucher" in title_lower:
            shopify_certs.append(v)
            
    print(f"[SYNC] Found {len(shopify_certs)} potential certificate variants in Shopify")

    # 3. Match and Update
    print("\n[PLANNING] Matching and updating...")
    
    for bx_id, bx_item in bx_certs.items():
        bx_name = bx_item["NAME"].lower()
        bx_price = float(bx_item["PRICE"] or 0)
        pid = bx_item["ID"]
        
        # Match logic:
        # 1. Price match (exact)
        # 2. Name contains "printed" or "e-certificate" / "electronic"
        
        matched_variant = None
        
        is_printed_bx = "printed" in bx_name
        is_electronic_bx = "e-certificate" in bx_name or "electronic" in bx_name
        
        for sv in shopify_certs:
            s_price = sv["price"]
            s_title = sv["title"].lower()
            
            if abs(s_price - bx_price) < 0.01:
                # Price matches. Check type.
                is_printed_sf = "printed" in s_title
                is_electronic_sf = "e-certificate" in s_title or "electronic" in s_title
                
                # If types match (or both undefined?)
                if is_printed_bx and is_printed_sf:
                    matched_variant = sv
                    break
                if is_electronic_bx and is_electronic_sf:
                    matched_variant = sv
                    break
                    
                # Fallback: if just one matches price and no conflicting type
                if not matched_variant:
                    matched_variant = sv

        if matched_variant:
            print(f"  [MATCH] '{bx_item['NAME']}' ({bx_price}) -> '{matched_variant['title']}' (VarID: {matched_variant['variant_id']})")
            
            # Fetch Image
            print(f"    Fetching image...")
            img_b64 = get_shopify_image_base64(matched_variant["variant_id"], matched_variant["product_id"], matched_variant.get("image_id"))
            
            if img_b64:
                 try:
                     res = requests.post(f"{BITRIX_WEBHOOK}crm.product.update", json={
                         "id": pid,
                         "fields": {
                             "PREVIEW_PICTURE": {"fileData": ["image.jpg", img_b64]},
                             "DETAIL_PICTURE": {"fileData": ["image.jpg", img_b64]}
                         }
                     })
                     print(f"    ✅ Updated Image for {pid}: {res.json().get('result')}")
                 except Exception as e:
                     print(f"    ❌ Update failed: {e}")
            else:
                print(f"    ⚠️ No image found in Shopify.")
        else:
            print(f"  [WARN] No match found for '{bx_item['NAME']}' ({bx_price})")
        
    print("\n[SYNC] Complete")

if __name__ == "__main__":
    run_sync()
