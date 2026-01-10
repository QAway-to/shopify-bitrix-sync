import requests
import time
from datetime import datetime

BITRIX = 'https://bfcshoes.bitrix24.eu/rest/52/zrbhiktlam8mz1yr/'

# Filter for documents created today
today = datetime.now().strftime("%Y-%m-%d")
print(f"Searching documents created >= {today}...")

r = requests.post(BITRIX + 'catalog.document.list', json={
    'filter': {'>DATE_CREATE': f'{today}T00:00:00'},
    'select': ['ID', 'TITLE', 'DOC_TYPE', 'DATE_CREATE']
})
docs = r.json().get('result', {}).get('documents', [])

print(f"Found {len(docs)} documents.")

for doc in docs:
    did = doc['id']
    title = doc['title']
    print(f"Processing Doc {did}: {title}...")
    
    # Cancel
    requests.post(BITRIX + 'catalog.document.cancel', json={'id': did})
    
    # Delete
    res = requests.post(BITRIX + 'catalog.document.delete', json={'id': did}).json()
    if res.get('result') == True:
        print(f"  Deleted Doc {did}")
    else:
        print(f"  FAILED Doc {did}: {res}")
    
    time.sleep(0.2)

print("\nRetrying Product Cleanup...")
# ... add product deletion here or run previous script
PROD_IDS = [
    10292, 10294, 10296, 10298, 10300, 10302, 10304, 10306, 10308, 10310,
    10312, 10314, 10316, 10318, 10320, 10322, 10324, 10326, 10328, 10330
]

for pid in PROD_IDS:
    r = requests.post(BITRIX + 'crm.product.delete', json={'id': pid}).json()
    if r.get('result') == True:
        print(f"  Deleted Product {pid}")
    else:
        print(f"  FAILED Product {pid}: {r.get('error_description')}")
