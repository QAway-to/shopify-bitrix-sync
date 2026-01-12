import requests
import time

# === CONFIGURATION ===
BITRIX_WEBHOOK = "https://bfcshoes.bitrix24.eu/rest/52/zrbhiktlam8mz1yr/"
STORE_ID = 2
TARGET_STOCK = 10000

def fetch_bitrix_products_in_section(section_id):
    print(f"\n[BITRIX] Fetching products in Section {section_id}...")
    products = {} 
    start = 0
    while True:
        resp = requests.post(f"{BITRIX_WEBHOOK}crm.product.list", json={
            "select": ["ID", "NAME", "XML_ID", "SECTION_ID"],
            "filter": {"SECTION_ID": section_id},
            "start": start
        }).json()
        
        items = resp.get("result", [])
        if not items: break
        
        for item in items:
            products[item["ID"]] = item
        
        if len(items) < 50: break
        start = resp.get("next")
        if not start: break
        
    print(f"[BITRIX] Found {len(products)} products in Section {section_id}")
    return products

def get_current_stock(product_id):
    resp = requests.post(f"{BITRIX_WEBHOOK}catalog.storeproduct.list", json={
        "filter": {"productId": product_id, "storeId": STORE_ID}
    }).json()
    items = resp.get("result", {}).get("storeProducts", [])
    if items:
        return int(float(items[0].get("amount", 0)))
    return 0

def main():
    print("=== FIX GIFT CARDS (CORRECT) ===\n")
    
    section_36_products = fetch_bitrix_products_in_section(36)
    
    gift_cards = []
    print("\n[FILTER] Searching for 'Gift', 'Certificate', 'FBFC' in names...")
    
    for pid, p in section_36_products.items():
        name = p.get("NAME", "").lower()
        is_gift = "gift" in name or "certificate" in name or "сертификат" in name or "fbfc" in name
        if is_gift:
            gift_cards.append(p)
            print(f"  [FOUND] {pid} - {p['NAME']}")
            
    print(f"\nFound {len(gift_cards)} Gift Cards.")
    
    if not gift_cards:
        return

    # Check current stock and calculate arrival amount
    arrivals = []
    print("\n[STOCK CHECK] Checking current stocks...")
    for p in gift_cards:
        current = get_current_stock(p["ID"])
        diff = TARGET_STOCK - current
        if diff > 0:
            arrivals.append({"id": p["ID"], "amount": diff, "name": p["NAME"]})
            print(f"  {p['ID']}: Current={current}, Need to add={diff}")
        else:
            print(f"  {p['ID']}: Already has {current} (>= {TARGET_STOCK}), SKIP")
            
    if not arrivals:
        print("\nAll cards already have sufficient stock.")
        return
        
    print(f"\n[EXECUTION] Creating stock document for {len(arrivals)} items...")
    
    # 1. Create Document
    doc_res = requests.post(f"{BITRIX_WEBHOOK}catalog.document.add", json={
        "fields": {
            "docType": "S",  # Stock Adjustment (like sync_inv uses)
            "title": "Gift Cards Stock Set 10000",
            "responsibleId": 52,
            "currency": "EUR"
        }
    }).json()
    
    doc_id = doc_res.get("result", {}).get("document", {}).get("id")
    if not doc_id:
        print(f"ERR Failed to create document: {doc_res}")
        return
        
    print(f"  Created document ID: {doc_id}")
    
    # 2. Add Elements
    print("  Adding elements...")
    for item in arrivals:
        elem_res = requests.post(f"{BITRIX_WEBHOOK}catalog.document.element.add", json={
            "fields": {
                "docId": doc_id,
                "elementId": item["id"],
                "amount": item["amount"],
                "purchasingPrice": 0,
                "storeTo": STORE_ID
            }
        }).json()
        
        if not elem_res.get("result"):
            print(f"    ERR Adding {item['id']}: {elem_res}")
        else:
            print(f"    OK Added {item['id']} ({item['name'][:30]}...): +{item['amount']}")
    
    # 3. Conduct Document
    print("  Conducting document...")
    conduct_res = requests.post(f"{BITRIX_WEBHOOK}catalog.document.conduct", json={
        "id": doc_id
    }).json()
    
    if conduct_res.get("result"):
        print(f"\nSUCCESS. Document {doc_id} conducted. Check Bitrix.")
    else:
        print(f"\nERROR conducting document: {conduct_res}")

if __name__ == "__main__":
    main()
