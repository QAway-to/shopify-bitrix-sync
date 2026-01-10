"""
Inventory Sync Script - Live API Version
- Fetches products directly from Shopify API (qty > 0 only)
- Fetches products from Bitrix API by section (36, 38, 40, 42)
- Syncs: price, qty, creates new products with properties (Size, Brand, Category)
- Size uses enum mapping to Bitrix property values
"""

import requests
import json
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# ============ CREDENTIALS ============
SHOPIFY_STORE = "83bfa8-c4.myshopify.com"
SHOPIFY_TOKEN = "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"
BITRIX_WEBHOOK = "https://bfcshoes.bitrix24.eu/rest/52/zrbhiktlam8mz1yr/"

# ============ SECTION MAPPING ============
SECTION_MAP = {
    'category-a-f': 36,
    'category-g-m': 38,
    'category-n-s': 40,
    'category-t-z': 42,
}

# ============ BITRIX PROPERTY IDs ============
PROPERTY_SIZE = 98      # Enum field
PROPERTY_BRAND = 102    # Text field
PROPERTY_CATEGORY = 104 # Text field
PROPERTY_COLOR = 106    # Text field

# ============ SIZE ENUM MAPPING (Bitrix property98 values) ============
SIZE_ENUM_MAP = {
    "20": 154, "21": 156, "22": 158, "23": 160, "24": 162,
    "25": 164, "26": 166, "27": 168, "28": 170, "29": 172,
    "30": 174, "31": 176, "32": 178, "33": 320, "34": 322,
    "35": 324, "36": 326, "37": 328, "38": 330, "39": 332,
    "40": 334, "41": 336, "42": 338, "43": 340, "44": 342,
    "45": 344, "46": 346, "47": 348, "48": 350, "49": 352,
    "50": 354, "51": 356, "52": 358, "53": 360, "54": 362
}

def get_size_enum_id(size_text: str) -> Optional[int]:
    """Convert size text (e.g. '40') to Bitrix enum ID (e.g. 334)"""
    if not size_text:
        return None
    # Clean the size text
    size_clean = size_text.strip()
    return SIZE_ENUM_MAP.get(size_clean)

def get_category_by_sku(sku: str) -> str:
    """Get category name based on SKU first letter"""
    if not sku:
        return 'category-g-m'
    
    first_char = sku[0].lower()
    
    if 'a' <= first_char <= 'f':
        return 'category-a-f'
    elif 'g' <= first_char <= 'm':
        return 'category-g-m'
    elif 'n' <= first_char <= 's':
        return 'category-n-s'
    elif 't' <= first_char <= 'z':
        return 'category-t-z'
    
    return 'category-g-m'

def get_section_id_by_sku(sku: str) -> int:
    """Get Bitrix section ID based on SKU first letter"""
    category = get_category_by_sku(sku)
    return SECTION_MAP.get(category, 38)

# ============ SHOPIFY API ============
def fetch_shopify_products(filter_qty_gt_zero: bool = True, target_variant_id: str = None) -> List[Dict]:
    """Fetch products from Shopify API with dynamic option parsing"""
    all_variants = []
    
    # Fast-fetch single variant if target specified
    if target_variant_id:
        print(f"\n[SHOPIFY] Fast-fetching single variant: {target_variant_id}")
        try:
            v_url = f"https://{SHOPIFY_STORE}/admin/api/2024-01/variants/{target_variant_id}.json"
            v_resp = requests.get(v_url, headers={"X-Shopify-Access-Token": SHOPIFY_TOKEN})
            
            if v_resp.status_code != 200:
                print(f"[SHOPIFY] Variant not found: {v_resp.text}")
                return []
            
            variant_data = v_resp.json().get("variant")
            product_id = variant_data.get("product_id")
            
            p_url = f"https://{SHOPIFY_STORE}/admin/api/2024-01/products/{product_id}.json"
            p_resp = requests.get(p_url, headers={"X-Shopify-Access-Token": SHOPIFY_TOKEN})
            
            if p_resp.status_code != 200:
                print(f"[SHOPIFY] Product not found: {p_resp.text}")
                return []
            
            products_to_process = [p_resp.json().get("product")]
        except Exception as e:
            print(f"[SHOPIFY] Error: {e}")
            return []
    else:
        # Full fetch
        print("\n[SHOPIFY] Fetching products from API...")
        products_to_process = []
        page_info = None
        has_next = True
        page_count = 0
        
        while has_next:
            url = f"https://{SHOPIFY_STORE}/admin/api/2024-01/products.json?limit=250"
            if page_info:
                url += f"&page_info={page_info}"
            
            response = requests.get(url, headers={
                "X-Shopify-Access-Token": SHOPIFY_TOKEN,
                "Content-Type": "application/json"
            })
            
            if response.status_code != 200:
                print(f"[SHOPIFY] API error: {response.status_code}")
                break
            
            data = response.json()
            products_to_process.extend(data.get("products", []))
            page_count += 1
            
            link_header = response.headers.get("Link", "")
            has_next = False
            if 'rel="next"' in link_header:
                try:
                    page_info = link_header.split("page_info=")[1].split(">")[0]
                    has_next = True
                except:
                    pass
            
            print(f"  Page {page_count}: {len(data.get('products', []))} products")
            if has_next:
                time.sleep(0.5)
    
    # Process products with dynamic option mapping
    for product in products_to_process:
        product_vendor = product.get("vendor", "")
        product_type = product.get("product_type", "")
        
        # Find Size and Color option indices dynamically
        size_index = -1
        color_index = -1
        
        for i, opt in enumerate(product.get("options", [])):
            opt_name = opt.get("name", "").lower()
            if "size" in opt_name or "eu size" in opt_name:
                size_index = i
            elif "color" in opt_name or "colour" in opt_name:
                color_index = i
        
        for variant in product.get("variants", []):
            vid = str(variant["id"])
            
            if target_variant_id and vid != target_variant_id:
                continue
            
            qty = variant.get("inventory_quantity", 0)
            if filter_qty_gt_zero and qty <= 0 and not target_variant_id:
                continue
            
            # Extract Size/Color from options
            size_val = variant.get(f"option{size_index+1}") if size_index >= 0 else ""
            color_val = variant.get(f"option{color_index+1}") if color_index >= 0 else ""
            
            # Fallback: use variant title as size if it looks numeric
            if not size_val:
                vt = variant.get("title", "")
                if vt and vt != "Default Title" and vt.isdigit():
                    size_val = vt
            
            all_variants.append({
                "product_id": product["id"],
                "product_title": product["title"],
                "product_handle": product.get("handle", ""),
                "brand": product_vendor,
                "category": product_type,
                "variant_id": variant["id"],
                "variant_title": variant.get("title", ""),
                "sku": variant.get("sku", ""),
                "price": float(variant.get("price", 0)),
                "qty": qty,
                "size": size_val,
                "color": color_val
            })
    
    print(f"[SHOPIFY] Done: {len(all_variants)} variants")
    return all_variants

# ============ BITRIX API ============
def call_bitrix(method: str, params: dict = None) -> dict:
    """Call Bitrix API"""
    url = f"{BITRIX_WEBHOOK}{method}"
    try:
        response = requests.post(url, json=params or {}, timeout=30)
        return response.json()
    except Exception as e:
        print(f"[BITRIX] API error: {e}")
        return {"error": str(e)}

def fetch_bitrix_products_by_section(section_id: int) -> List[Dict]:
    """Fetch all products from a Bitrix section with pagination"""
    all_products = []
    start = 0
    
    while True:
        result = call_bitrix("crm.product.list", {
            "filter": {"SECTION_ID": section_id},
            "select": ["ID", "NAME", "PRICE", "CODE", "XML_ID", "SECTION_ID"],
            "start": start
        })
        
        products = result.get("result", [])
        if not products:
            break
            
        all_products.extend(products)
        
        total = result.get("total", 0)
        start += 50
        
        if start >= total or len(products) < 50:
            break
            
        time.sleep(0.3)
    
    return all_products

def fetch_all_bitrix_products() -> Dict[str, Dict]:
    """Fetch all products from all sections, indexed by variant_id (XML_ID)"""
    all_products = {}
    
    print("[BITRIX] Fetching products from all sections...")
    for category, section_id in SECTION_MAP.items():
        products = fetch_bitrix_products_by_section(section_id)
        print(f"  Section {section_id}: {len(products)} products")
        
        for product in products:
            xml_id = product.get("XML_ID", "")
            if xml_id:
                all_products[xml_id] = product
                
    print(f"[BITRIX] Total: {len(all_products)} products indexed")
    return all_products

def update_bitrix_product(product_id: int, fields: dict) -> bool:
    """Update a Bitrix product"""
    result = call_bitrix("crm.product.update", {
        "id": product_id,
        "fields": fields
    })
    return result.get("result", False)

def create_bitrix_product(fields: dict) -> Optional[int]:
    """Create a new Bitrix product"""
    result = call_bitrix("crm.product.add", {"fields": fields})
    return result.get("result")

def get_current_stock(product_id: int) -> int:
    """Get current stock for a product"""
    result = call_bitrix("catalog.storeproduct.list", {
        "filter": {"PRODUCT_ID": product_id},
        "select": ["AMOUNT"]
    })
    
    items = result.get("result", {})
    if isinstance(items, dict):
        items = items.get("storeProducts", [])
    
    if items and len(items) > 0:
        amount = items[0].get("amount")
        if amount is not None:
            return int(float(amount))
    
    return 0

def create_stock_document(product_id: int, amount: int, doc_type: str = "A") -> Optional[int]:
    """Create stock adjustment document (A=arrival, W=write-off)"""
    doc_result = call_bitrix("catalog.document.add", {
        "fields": {
            "docType": doc_type,
            "title": f"Sync from Shopify",
            "responsibleId": 52,
            "currency": "EUR"
        }
    })
    
    doc_id = None
    if isinstance(doc_result.get("result"), dict):
        doc_id = doc_result["result"].get("document", {}).get("id")
    elif isinstance(doc_result.get("result"), int):
        doc_id = doc_result["result"]
    
    if not doc_id:
        return None
    
    call_bitrix("catalog.document.element.add", {
        "fields": {
            "docId": doc_id,
            "elementId": product_id,
            "amount": abs(amount),
            "purchasingPrice": 0
        }
    })
    
    call_bitrix("catalog.document.conduct", {"id": doc_id})
    
    return doc_id

# ============ SYNC LOGIC ============
def sync_product(shopify_variant: Dict, bitrix_products: Dict[str, Dict], stats: Dict):
    """Sync a single product variant between Shopify and Bitrix"""
    variant_id = str(shopify_variant["variant_id"])
    sku = shopify_variant.get("sku", "")
    shopify_price = shopify_variant["price"]
    shopify_qty = shopify_variant["qty"]
    product_title = shopify_variant["product_title"]
    variant_title = shopify_variant.get("variant_title", "")
    
    # Additional properties
    brand = shopify_variant.get("brand", "")
    category = shopify_variant.get("category", "")
    size_text = shopify_variant.get("size", "")
    color = shopify_variant.get("color", "")
    
    # Convert size to enum ID
    size_enum_id = get_size_enum_id(size_text)
    
    # Build product name
    name = f"{product_title} - {variant_title}" if variant_title else product_title
    
    print(f"\n  SKU: {sku or 'N/A'} | variant_id: {variant_id}")
    
    # Check if product exists in Bitrix
    bitrix_product = bitrix_products.get(variant_id)
    
    if bitrix_product:
        # Product exists - check for updates
        product_id = int(bitrix_product["ID"])
        bitrix_price = float(bitrix_product.get("PRICE", 0) or 0)
        
        updates = {}
        
        # Price sync
        if abs(bitrix_price - shopify_price) > 0.01:
            updates["PRICE"] = shopify_price
            print(f"    Price: {bitrix_price} -> {shopify_price}")
            stats["price_updated"] += 1
        
        # Name sync
        if bitrix_product.get("NAME") != name:
            updates["NAME"] = name
        
        # Apply updates
        if updates:
            success = update_bitrix_product(product_id, updates)
            if success:
                print(f"    Updated product ID {product_id}")
        
        # Stock sync
        current_stock = get_current_stock(product_id)
        diff = shopify_qty - current_stock
        
        if diff > 0:
            print(f"    Stock: {current_stock} -> {shopify_qty} (+{diff})")
            create_stock_document(product_id, diff, "A")
            stats["qty_updated"] += 1
        elif diff < 0:
            print(f"    Stock: {current_stock} -> {shopify_qty} ({diff})")
            create_stock_document(product_id, abs(diff), "W")
            stats["qty_updated"] += 1
        else:
            print(f"    Stock OK: {current_stock}")
            stats["skipped"] += 1
            
    else:
        # Product doesn't exist - create it with all properties
        section_id = get_section_id_by_sku(sku)
        print(f"    Creating new product in section {section_id}...")
        
        fields = {
            "NAME": name,
            "PRICE": shopify_price,
            "CURRENCY_ID": "EUR",
            "CATALOG_ID": 14,
            "SECTION_ID": section_id,
            "CODE": sku or str(variant_id),
            "XML_ID": variant_id,
            "ACTIVE": "Y"
        }
        
        # Add properties
        if size_enum_id:
            fields[f"PROPERTY_{PROPERTY_SIZE}"] = size_enum_id
            print(f"    Size: {size_text} -> enum {size_enum_id}")
        if brand:
            fields[f"PROPERTY_{PROPERTY_BRAND}"] = brand
        if category:
            fields[f"PROPERTY_{PROPERTY_CATEGORY}"] = category
        if color:
            fields[f"PROPERTY_{PROPERTY_COLOR}"] = color
        
        new_id = create_bitrix_product(fields)
        
        if new_id:
            print(f"    Created product ID {new_id}")
            
            # Add initial stock
            if shopify_qty > 0:
                create_stock_document(new_id, shopify_qty, "A")
            
            stats["created"] += 1
        else:
            print(f"    Failed to create product")
            stats["errors"] += 1
            
    stats["synced"] += 1

def run_full_sync(limit: int = None, dry_run: bool = False, target_variant_id: str = None):
    """Run full inventory sync"""
    print("=" * 60)
    print("  INVENTORY SYNC - LIVE API")
    if target_variant_id:
        print(f"  TARGET: {target_variant_id}")
    print("=" * 60)
    
    start_time = time.time()
    
    # 1. Fetch from Shopify
    shopify_variants = fetch_shopify_products(
        filter_qty_gt_zero=True, 
        target_variant_id=target_variant_id
    )
    
    if not shopify_variants:
        print("No variants found to sync.")
        return {"synced": 0}
    
    if limit:
        shopify_variants = shopify_variants[:limit]
        print(f"[LIMIT] Processing only first {limit} variants")
    
    # 2. Fetch from Bitrix
    bitrix_products = fetch_all_bitrix_products()
    
    # 3. Stats
    stats = {
        "synced": 0,
        "created": 0,
        "price_updated": 0,
        "qty_updated": 0,
        "skipped": 0,
        "errors": 0
    }
    
    # 4. Sync each variant
    print(f"\n[SYNC] Processing {len(shopify_variants)} variants...")
    print("-" * 60)
    
    for i, variant in enumerate(shopify_variants):
        if dry_run:
            print(f"  [DRY RUN] Would sync: {variant.get('sku')} (variant_id: {variant['variant_id']})")
            stats["synced"] += 1
            continue
            
        try:
            sync_product(variant, bitrix_products, stats)
        except Exception as e:
            print(f"    Error: {e}")
            stats["errors"] += 1
        
        time.sleep(0.3)
        
        if (i + 1) % 50 == 0:
            print(f"\n  Progress: {i + 1}/{len(shopify_variants)}")
    
    # 5. Summary
    duration = time.time() - start_time
    
    print("\n" + "=" * 60)
    print("  SYNC SUMMARY")
    print("=" * 60)
    print(f"  Duration:      {duration:.1f}s")
    print(f"  Synced:        {stats['synced']}")
    print(f"  Created:       {stats['created']}")
    print(f"  Price updated: {stats['price_updated']}")
    print(f"  Qty updated:   {stats['qty_updated']}")
    print(f"  Skipped:       {stats['skipped']}")
    print(f"  Errors:        {stats['errors']}")
    print("=" * 60)
    
    return stats


# ============ MIDDLEWARE-READY FUNCTIONS ============
def sync_inventory():
    """Main entry point for middleware"""
    return run_full_sync()

def sync_inventory_limited(limit: int = 20):
    """Limited sync for testing"""
    return run_full_sync(limit=limit)

def sync_inventory_dry_run():
    """Dry run - no actual changes"""
    return run_full_sync(dry_run=True)

def sync_single_product(variant_id: str):
    """Sync a single product by variant_id"""
    return run_full_sync(target_variant_id=variant_id)


if __name__ == "__main__":
    # Run full sync (all products)
    run_full_sync(limit=None)
