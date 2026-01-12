import requests
SHOPIFY_STORE = "83bfa8-c4.myshopify.com"
SHOPIFY_TOKEN = "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"

VID = "50426892222728"

def get_variant_debug():
    # 1. Get Variant
    print(f"Fetching Variant {VID}...")
    v_url = f"https://{SHOPIFY_STORE}/admin/api/2024-01/variants/{VID}.json"
    res = requests.get(v_url, headers={"X-Shopify-Access-Token": SHOPIFY_TOKEN})
    if not res.ok:
        print(f"Failed: {res.text}")
        return
        
    variant = res.json().get("variant")
    pid = variant["product_id"]
    sku = variant["sku"]
    qty = variant["inventory_quantity"]
    
    # 2. Get Product for Type
    p_url = f"https://{SHOPIFY_STORE}/admin/api/2024-01/products/{pid}.json"
    p_res = requests.get(p_url, headers={"X-Shopify-Access-Token": SHOPIFY_TOKEN})
    product = p_res.json().get("product")
    p_type = product["product_type"]
    p_vendor = product["vendor"]
    
    print("\n=== DEBUG INFO ===")
    print(f"Variant ID: {VID}")
    print(f"Product ID: {pid}")
    print(f"Title: {product['title']}")
    print(f"SKU: '{sku}'")
    print(f"Qty: {qty}")
    print(f"Product Type: '{p_type}'")
    print(f"Vendor: '{p_vendor}'")

    # Check Section Logic
    first_char = sku[0] if sku else "?"
    print(f"First Char of SKU: '{first_char}'")
    if 'A' <= first_char <= 'F': section = "36 (A-F)"
    else: section = "Other"
    print(f"Calculated Section: {section}")

if __name__ == "__main__":
    get_variant_debug()
