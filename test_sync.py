"""
Inventory Sync Test Script
Tests the sync logic between Shopify and Bitrix locally
"""
import requests
import time
from typing import Optional

# ============ CREDENTIALS ============
SHOPIFY_STORE = "83bfa8-c4.myshopify.com"
SHOPIFY_TOKEN = "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"
BITRIX_WEBHOOK = "https://bfcshoes.bitrix24.eu/rest/52/zrbhiktlam8mz1yr/"

# ============ SECTION MAPPING ============
def get_section_id_by_sku(sku: str) -> int:
    """Get Bitrix section ID based on SKU first letter"""
    if not sku:
        return 38  # Default
    
    first_char = sku[0].lower()
    
    if 'a' <= first_char <= 'f':
        return 36
    elif 'g' <= first_char <= 'm':
        return 38
    elif 'n' <= first_char <= 's':
        return 40
    elif 't' <= first_char <= 'z':
        return 42
    
    return 38  # Default

# ============ SHOPIFY API ============
def fetch_all_shopify_products(limit: int = 50):
    """Fetch all products from Shopify with pagination"""
    all_variants = []
    page_info = None
    has_next = True
    page_count = 0
    
    print(f"\n📦 Fetching products from Shopify (limit: {limit} per page)...")
    
    while has_next:
        url = f"https://{SHOPIFY_STORE}/admin/api/2024-01/products.json?limit=250"
        if page_info:
            url = f"https://{SHOPIFY_STORE}/admin/api/2024-01/products.json?limit=250&page_info={page_info}"
        
        response = requests.get(url, headers={
            "X-Shopify-Access-Token": SHOPIFY_TOKEN,
            "Content-Type": "application/json"
        })
        
        if response.status_code != 200:
            print(f"❌ Shopify API error: {response.status_code} - {response.text[:200]}")
            break
        
        data = response.json()
        products = data.get("products", [])
        page_count += 1
        
        for product in products:
            for variant in product.get("variants", []):
                all_variants.append({
                    "product_id": product["id"],
                    "product_title": product["title"],
                    "variant_id": variant["id"],
                    "variant_title": variant.get("title", ""),
                    "sku": variant.get("sku", ""),
                    "price": float(variant.get("price", 0)),
                    "qty": variant.get("inventory_quantity", 0)
                })
        
        # Check pagination
        link_header = response.headers.get("Link", "")
        has_next = False
        page_info = None
        
        if 'rel="next"' in link_header:
            for part in link_header.split(", "):
                if 'rel="next"' in part:
                    page_info = part.split("page_info=")[1].split(">")[0]
                    has_next = True
                    break
        
        print(f"  Page {page_count}: {len(products)} products fetched, total variants: {len(all_variants)}")
        
        # Limit for testing
        if len(all_variants) >= limit:
            print(f"  ⚠️ Stopping at {limit} variants for testing")
            break
        
        if has_next:
            time.sleep(0.5)  # Rate limiting
    
    return all_variants

# ============ BITRIX API ============
def call_bitrix(method: str, params: dict = None):
    """Call Bitrix API"""
    url = f"{BITRIX_WEBHOOK}{method}"
    response = requests.post(url, json=params or {})
    return response.json()

def find_product_by_variant_id(variant_id: str) -> Optional[int]:
    """Find Bitrix product by variant_id (XML_ID)"""
    result = call_bitrix("crm.product.list", {
        "filter": {"XML_ID": str(variant_id)},
        "select": ["ID", "NAME", "PRICE"]
    })
    
    products = result.get("result", [])
    if products:
        return int(products[0]["ID"]), float(products[0].get("PRICE", 0))
    return None, None

def create_bitrix_product(variant: dict, section_id: int) -> int:
    """Create product in Bitrix"""
    name = f"{variant['product_title']} - {variant['variant_title']}" if variant['variant_title'] else variant['product_title']
    
    result = call_bitrix("crm.product.add", {
        "fields": {
            "NAME": name,
            "PRICE": variant["price"],
            "CURRENCY_ID": "EUR",
            "CATALOG_ID": 14,
            "SECTION_ID": section_id,
            "CODE": variant["sku"] or str(variant["variant_id"]),
            "XML_ID": str(variant["variant_id"]),
            "ACTIVE": "Y"
        }
    })
    
    return result.get("result")

def update_bitrix_price(product_id: int, new_price: float):
    """Update product price in Bitrix"""
    call_bitrix("crm.product.update", {
        "id": product_id,
        "fields": {"PRICE": new_price}
    })

def get_current_stock(product_id: int) -> int:
    """Get current stock for product"""
    result = call_bitrix("catalog.storeproduct.list", {
        "filter": {"PRODUCT_ID": product_id},
        "select": ["AMOUNT"]
    })
    
    items = result.get("result", {}).get("storeProducts", [])
    if items:
        return int(float(items[0].get("amount", 0)))
    return 0

def create_incoming_document(product_id: int, amount: int, title: str):
    """Create stock incoming document"""
    result = call_bitrix("catalog.document.add", {
        "fields": {
            "docType": "A",  # Arrival
            "title": title,
            "responsibleId": 52,
            "currency": "EUR"
        }
    })
    
    doc_id = result.get("result", {}).get("document", {}).get("id")
    if doc_id:
        call_bitrix("catalog.document.element.add", {
            "fields": {
                "docId": doc_id,
                "elementId": product_id,
                "amount": amount,
                "purchasingPrice": 0
            }
        })
        call_bitrix("catalog.document.conduct", {"id": doc_id})
    
    return doc_id

# ============ MAIN SYNC LOGIC ============
def run_sync(max_variants: int = 20):
    """Run inventory sync with limit"""
    print("=" * 60)
    print("🔄 INVENTORY SYNC TEST")
    print("=" * 60)
    
    # 1. Fetch from Shopify
    variants = fetch_all_shopify_products(limit=max_variants)
    
    # 2. Filter qty > 0
    variants_with_stock = [v for v in variants if v["qty"] > 0]
    print(f"\n📊 Total variants: {len(variants)}, with qty > 0: {len(variants_with_stock)}")
    
    # 3. Sync each variant
    stats = {
        "synced": 0,
        "created": 0,
        "price_updated": 0,
        "qty_updated": 0,
        "skipped": 0,
        "errors": 0
    }
    
    print(f"\n🔄 Processing {len(variants_with_stock)} variants...")
    print("-" * 60)
    
    for i, variant in enumerate(variants_with_stock):
        try:
            sku = variant["sku"] or ""
            variant_id = str(variant["variant_id"])
            shopify_price = variant["price"]
            shopify_qty = variant["qty"]
            
            print(f"\n[{i+1}/{len(variants_with_stock)}] SKU: {sku or 'N/A'}, variant_id: {variant_id}")
            print(f"    Shopify: price={shopify_price}, qty={shopify_qty}")
            
            # Find in Bitrix
            product_id, bitrix_price = find_product_by_variant_id(variant_id)
            
            if product_id:
                print(f"    Found in Bitrix: ID={product_id}, price={bitrix_price}")
                
                # Check price
                if abs(bitrix_price - shopify_price) > 0.01:
                    print(f"    💰 Price update: {bitrix_price} → {shopify_price}")
                    update_bitrix_price(product_id, shopify_price)
                    stats["price_updated"] += 1
                
                # Check stock
                current_stock = get_current_stock(product_id)
                diff = shopify_qty - current_stock
                
                if diff > 0:
                    print(f"    📈 Stock update: {current_stock} → {shopify_qty} (+{diff})")
                    create_incoming_document(product_id, diff, f"Sync from Shopify: {sku}")
                    stats["qty_updated"] += 1
                elif diff == 0:
                    print(f"    ✓ Stock OK: {current_stock}")
                    stats["skipped"] += 1
                else:
                    print(f"    ⚠️ Bitrix has more stock: {current_stock} > {shopify_qty}")
                    stats["skipped"] += 1
            else:
                # Create new product
                section_id = get_section_id_by_sku(sku)
                print(f"    ➕ Creating new product in section {section_id}...")
                new_id = create_bitrix_product(variant, section_id)
                
                if new_id:
                    print(f"    ✅ Created: ID={new_id}")
                    # Add initial stock
                    if shopify_qty > 0:
                        create_incoming_document(new_id, shopify_qty, f"Initial sync: {sku}")
                    stats["created"] += 1
                else:
                    print(f"    ❌ Failed to create product")
                    stats["errors"] += 1
            
            stats["synced"] += 1
            time.sleep(0.3)  # Rate limiting
            
        except Exception as e:
            print(f"    ❌ Error: {e}")
            stats["errors"] += 1
    
    # Summary
    print("\n" + "=" * 60)
    print("📊 SYNC SUMMARY")
    print("=" * 60)
    print(f"  Synced:        {stats['synced']}")
    print(f"  Created:       {stats['created']}")
    print(f"  Price updated: {stats['price_updated']}")
    print(f"  Qty updated:   {stats['qty_updated']}")
    print(f"  Skipped:       {stats['skipped']}")
    print(f"  Errors:        {stats['errors']}")
    print("=" * 60)
    
    return stats

if __name__ == "__main__":
    # Run with limited variants for testing
    run_sync(max_variants=20)
