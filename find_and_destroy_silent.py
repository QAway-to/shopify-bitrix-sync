import requests
import time
from datetime import datetime

BITRIX = 'https://bfcshoes.bitrix24.eu/rest/52/zrbhiktlam8mz1yr/'

today = datetime.now().strftime("%Y-%m-%d")
print(f"Silent destroy >= {today}...")

# Sort DESC to hit newest first
r = requests.post(BITRIX + 'catalog.document.list', json={
    'filter': {'>DATE_CREATE': f'{today}T00:00:00'},
    'select': ['ID'],
    'order': {'ID': 'DESC'}
})
docs = r.json().get('result', {}).get('documents', [])

print(f"Found {len(docs)} documents.")

for doc in docs:
    did = doc['id']
    # Skip very old IDs if needed, but let's try all today's
    try:
        requests.post(BITRIX + 'catalog.document.cancel', json={'id': did})
        res = requests.post(BITRIX + 'catalog.document.delete', json={'id': did}).json()
        if res.get('result') == True:
            print(f"Deleted Doc {did}")
        else:
            # Silence expected errors for old locked docs
            pass
    except:
        pass
    time.sleep(0.1)

print("Retrying Product Deletion...")
PROD_IDS = [
    10292, 10294, 10296, 10298, 10300, 10302, 10304, 10306, 10308, 10310,
    10312, 10314, 10316, 10318, 10320, 10322, 10324, 10326, 10328, 10330
]

for pid in PROD_IDS:
    r = requests.post(BITRIX + 'crm.product.delete', json={'id': pid}).json()
    if r.get('result') == True:
        print(f"Deleted Product {pid}")
    else:
        print(f"FAILED Product {pid}")
