import requests
import time

BITRIX = 'https://bfcshoes.bitrix24.eu/rest/52/zrbhiktlam8mz1yr/'

# All test product IDs
PROD_IDS = [
    10292, 10294, 10296, 10298, 10300, 10302, 10304, 10306, 10308, 10310,
    10312, 10314, 10316, 10318, 10320, 10322, 10324, 10326, 10328, 10330
]

print(f"Force cleaning {len(PROD_IDS)} products...")

for pid in PROD_IDS:
    print(f"\nProcessing Product {pid}...")
    
    # 1. Find documents for this product
    # Bitrix doesn't have a direct "get docs for product" API easy to use, 
    # but we can try to delete product and see if it fails (we know it fails).
    
    # We will fetch 'catalog.document.element.list' filtering by elementId (productId)
    # But wait, document.element.list isn't always available or efficient.
    # A better approach: List ALL recent documents and check if they contain our products? Too slow.
    
    # Let's try to list documents created today and see if they look like ours.
    # IDs 5822, 5824, 5826 are known. Let's start with those.
    pass 

# Strategy: Explicitly delete known Test Docs first
DOCS_TO_KILL = [5822, 5824, 5826] 

print("Killing Known Docs...")
for doc_id in DOCS_TO_KILL:
    # Check if exists
    r = requests.post(BITRIX + 'catalog.document.get', json={'id': doc_id})
    if r.json().get('result'):
        print(f"Cancelling Doc {doc_id}...")
        requests.post(BITRIX + 'catalog.document.cancel', json={'id': doc_id})
        time.sleep(1)
        
        print(f"Deleting Doc {doc_id}...")
        res = requests.post(BITRIX + 'catalog.document.delete', json={'id': doc_id}).json()
        print(f"Result: {res}")
    else:
        print(f"Doc {doc_id} not found (freshly deleted?)")

# Strategy 2: If products still persist, we might need to find other docs.
# But let's try deleting products again.

print("\nRetrying Product Deletion...")
for pid in PROD_IDS:
    # First, deactivate (just in case)
    requests.post(BITRIX + 'crm.product.update', json={'id': pid, 'fields': {'ACTIVE': 'N'}})
    
    r = requests.post(BITRIX + 'crm.product.delete', json={'id': pid})
    res = r.json()
    if res.get('result') == True:
        print(f"✅ Deleted {pid}")
    else:
        print(f"❌ Failed {pid}: {res.get('error_description')}")
    time.sleep(0.2)
