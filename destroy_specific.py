import requests
import time

BITRIX = 'https://bfcshoes.bitrix24.eu/rest/52/zrbhiktlam8mz1yr/'

TITLES = [
    'Batch Test STOCK',
    'Batch Test PROPERTIES',
    'CLEANUP TEST PRODUCTS',
    'Manual Test +1'
]

print("Searching for specific documents to destroy...")

r = requests.post(BITRIX + 'catalog.document.list', json={
    'select': ['ID', 'TITLE', 'STATUS'],
    'order': {'ID': 'DESC'},
    'filter': {'%TITLE': 'Test'} # Broad filter, will check specific titles in loop
})
docs = r.json().get('result', {}).get('documents', [])

print(f"Found {len(docs)} documents checking titles...")

deleted_count = 0
for doc in docs:
    did = doc['id']
    title = doc['title']
    
    # Check match
    match = False
    for t in TITLES:
        if t in title:
            match = True
            break
    
    if match:
        print(f"Target Acquired: Doc {did} - {title} (Status: {doc['status']})")
        
        # Cancel first if processed
        if doc['status'] == 'Y':
            print(f"  Cancelling Doc {did}...")
            requests.post(BITRIX + 'catalog.document.cancel', json={'id': did})
            time.sleep(0.5)
        
        # Delete
        print(f"  Deleting Doc {did}...")
        res = requests.post(BITRIX + 'catalog.document.delete', json={'id': did}).json()
        if res.get('result') == True:
            print(f"  ✅ Deleted Doc {did}")
            deleted_count += 1
        else:
            print(f"  ❌ Failed to delete Doc {did}: {res}")
            
        time.sleep(0.2)

if deleted_count == 0:
    print("No matching documents found/deleted.")
else:
    print(f"Deleted {deleted_count} documents.")

print("\nFinal Attempt: Delete Products...")
PROD_IDS = [
    10292, 10294, 10296, 10298, 10300, 10302, 10304, 10306, 10308, 10310,
    10312, 10314, 10316, 10318, 10320, 10322, 10324, 10326, 10328, 10330,
    4122 # Manual test +1
]
# Note: 4122 shouldn't be deleted if it's a real product, but I'll exclude it just in case user wants to keep it.
# User asked about 4122 - "update qty +1". So I should NOT delete 4122.
REAL_PRODUCTS = [4122]
TEST_PRODUCTS = [pid for pid in PROD_IDS if pid not in REAL_PRODUCTS]

for pid in TEST_PRODUCTS:
    r = requests.post(BITRIX + 'crm.product.delete', json={'id': pid}).json()
    if r.get('result') == True:
        print(f"  Deleted Product {pid}")
    else:
        # Don't print excessively if already deleted
        if 'not found' not in str(r):
            print(f"  FAILED Product {pid}: {r.get('error_description')}")
