import requests
import time

BITRIX = 'https://bfcshoes.bitrix24.eu/rest/52/zrbhiktlam8mz1yr/'

PROD_IDS = [
    10292, 10294, 10296, 10298, 10300, 10302, 10304, 10306, 10308, 10310,
    10312, 10314, 10316, 10318, 10320, 10322, 10324, 10326, 10328, 10330
]

print("Retrying DELETE (No Emoji)...")
for pid in PROD_IDS:
    # 1. Update active to N
    requests.post(BITRIX + 'crm.product.update', json={'id': pid, 'fields': {'ACTIVE': 'N'}})
    
    # 2. Delete
    r = requests.post(BITRIX + 'crm.product.delete', json={'id': pid})
    res = r.json()
    if res.get('result') == True:
        print(f"DELETED {pid}")
    else:
        print(f"FAILED {pid}: {res.get('error_description')}")
    time.sleep(0.1)
