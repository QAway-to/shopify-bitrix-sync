import requests
import time

BITRIX = 'https://bfcshoes.bitrix24.eu/rest/52/zrbhiktlam8mz1yr/'

# Docs to delete
DOC_IDS = [5822, 5824, 5826]

# Products to delete
PROD_IDS = [
    10292, 10294, 10296, 10298, 10300, 10302, 10304, 10306, 10308, 10310,
    10312, 10314, 10316, 10318, 10320, 10322, 10324, 10326, 10328, 10330
]

print("1. Cancelling & Deleting Documents...")
for did in DOC_IDS:
    try:
        # Cancel first
        print(f"Cancelling Doc {did}...")
        requests.post(BITRIX + 'catalog.document.cancel', json={'id': did})
        time.sleep(0.5)
        
        # Then delete
        print(f"Deleting Doc {did}...")
        r = requests.post(BITRIX + 'catalog.document.delete', json={'id': did})
        print(f"Delete Doc {did}: {r.json().get('result')}")
        time.sleep(0.5)
    except Exception as e:
        print(f"Error Doc {did}: {e}")

print("\n2. Deleting Products...")
for pid in PROD_IDS:
    try:
        r = requests.post(BITRIX + 'crm.product.delete', json={'id': pid})
        res = r.json()
        if res.get("result") == True:
            print(f"Deleted {pid}: OK")
        else:
            print(f"Deleted {pid}: FAIL - {res}")
        time.sleep(0.3)
    except Exception as e:
        print(f"Error Prod {pid}: {e}")
