# Garment Seed Data For Postman

Use this order so foreign keys are available:

1. Register admin
2. Login and save `access_token`
3. Create plants
4. Create brands
5. Create users
6. Create assets
7. Create maintenances
8. Create transfers
9. Create borrowings

Suggested Postman variables:

- `baseUrl` = `http://localhost:8000/api`
- `token`
- `plant_bd_id`
- `plant_hcm_id`
- `plant_kho_id`
- `brand_juki_id`
- `brand_brother_id`
- `brand_jack_id`
- `brand_siruba_id`
- `user_quan_doc_bd_id`
- `user_ky_thuat_hcm_id`
- `user_nhan_vien_kho_id`
- `asset_mm001_id`
- `asset_mm002_id`
- `asset_mm003_id`

Headers for protected routes:

```http
Authorization: Bearer {{token}}
Content-Type: application/json
```

## 1. Register Admin

`POST {{baseUrl}}/auth/register`

```json
{
  "fullname": "Admin Quan Ly May Mac",
  "username": "admin.garment",
  "email": "admin.garment@example.com",
  "password": "123456",
  "phone": "0909000001"
}
```

## 2. Login

`POST {{baseUrl}}/auth/login`

```json
{
  "email": "admin.garment@example.com",
  "password": "123456"
}
```

Save `access_token` from response into `{{token}}`.

## 3. Plants

`POST {{baseUrl}}/plants`

### Plant 1

```json
{
  "name": "Nha may Binh Duong",
  "code": "BD01",
  "address": "KCN VSIP 1, Thuan An, Binh Duong",
  "phone": "02743888801"
}
```

### Plant 2

```json
{
  "name": "Nha may HCM",
  "code": "HCM01",
  "address": "Le Minh Xuan, Binh Chanh, TP HCM",
  "phone": "02838888002"
}
```

### Plant 3

```json
{
  "name": "Kho tong phu lieu va may du phong",
  "code": "KHO01",
  "address": "Di An, Binh Duong",
  "phone": "02743888803"
}
```

## 4. Brands

`POST {{baseUrl}}/brands`

### Juki

```json
{
  "name": "Juki",
  "description": "Thuong hieu may may cong nghiep Nhat Ban, noi tieng voi may 1 kim va may dinh bo"
}
```

### Brother

```json
{
  "name": "Brother",
  "description": "Thuong hieu may may cong nghiep su dung nhieu trong chuyen may ao so mi va quan tay"
}
```

### Jack

```json
{
  "name": "Jack",
  "description": "Dong may may dien tu pho bien cho nha may may mac san luong lon"
}
```

### Siruba

```json
{
  "name": "Siruba",
  "description": "Manh ve may kansai, may vat so va cac dong may dung trong nganh may"
}
```

### Pegasus

```json
{
  "name": "Pegasus",
  "description": "Thuong hieu chuyen may vat so toc do cao va may may chuyen dung"
}
```

## 5. Users

`POST {{baseUrl}}/users`

### Quan doc Binh Duong

```json
{
  "name": "Tran Van Quan",
  "email": "quan.bd@example.com",
  "password": "123456",
  "phone": "0909111001",
  "role": "manager",
  "plantId": "{{plant_bd_id}}",
  "isActive": true
}
```

### Ky thuat vien HCM

```json
{
  "name": "Nguyen Van Ky",
  "email": "ky.hcm@example.com",
  "password": "123456",
  "phone": "0909222002",
  "role": "staff",
  "plantId": "{{plant_hcm_id}}",
  "isActive": true
}
```

### Nhan vien kho

```json
{
  "name": "Le Thi Kho",
  "email": "kho.tong@example.com",
  "password": "123456",
  "phone": "0909333003",
  "role": "staff",
  "plantId": "{{plant_kho_id}}",
  "isActive": true
}
```

## 6. Assets

`POST {{baseUrl}}/assets`

### Asset 1 - May 1 kim dien tu

```json
{
  "name": "May 1 kim dien tu Juki DDL-8000A",
  "machineCode": "MM001",
  "serial": "JUKI-DDL8000A-240001",
  "type": "May 1 kim dien tu",
  "brandId": "{{brand_juki_id}}",
  "plantId": "{{plant_bd_id}}",
  "area": "Xuong May 1 - Chuyen A",
  "status": "active",
  "purchaseDate": "2024-01-15",
  "purchasePrice": 18500000,
  "specifications": {
    "tocDoMay": "5000 mui/phut",
    "doNangChanVit": "15 mm",
    "dongCo": "Servo tiet kiem dien",
    "ungDung": "May ao thun, ao so mi"
  },
  "note": "May dang hoat dong on dinh tren chuyen may ao polo"
}
```

### Asset 2 - May vat so 4 chi

```json
{
  "name": "May vat so 4 chi Jack E4S",
  "machineCode": "MM002",
  "serial": "JACK-E4S-240002",
  "type": "May vat so 4 chi",
  "brandId": "{{brand_jack_id}}",
  "plantId": "{{plant_bd_id}}",
  "area": "Xuong May 1 - Khu vat so",
  "status": "maintenance",
  "purchaseDate": "2024-02-10",
  "purchasePrice": 12800000,
  "specifications": {
    "tocDoMay": "5500 mui/phut",
    "soChi": "4 chi",
    "ungDung": "Vat so ao thun, do tre em"
  },
  "note": "Dang cho thay dao va can chinh bo kep chi"
}
```

### Asset 3 - May kansai

```json
{
  "name": "May kansai Siruba F007K",
  "machineCode": "MM003",
  "serial": "SIRUBA-F007K-240003",
  "type": "May kansai",
  "brandId": "{{brand_siruba_id}}",
  "plantId": "{{plant_hcm_id}}",
  "area": "Xuong Thun - Chuyen 3",
  "status": "active",
  "purchaseDate": "2023-11-22",
  "purchasePrice": 16200000,
  "specifications": {
    "soKim": "3 kim",
    "tocDoMay": "4200 mui/phut",
    "ungDung": "Len lai, may vien lai ao thun"
  },
  "note": "Su dung de len lai than ao thun cao cap"
}
```

### Asset 4 - May 2 kim co dinh

```json
{
  "name": "May 2 kim co dinh Brother LH-3528A",
  "machineCode": "MM004",
  "serial": "BROTHER-LH3528A-240004",
  "type": "May 2 kim co dinh",
  "brandId": "{{brand_brother_id}}",
  "plantId": "{{plant_hcm_id}}",
  "area": "Xuong Quan Tay - Cum may so 2",
  "status": "borrowing",
  "purchaseDate": "2024-03-05",
  "purchasePrice": 21900000,
  "specifications": {
    "kimMay": "2 kim",
    "ungDung": "May duong song song tren quan tay va ao jacket"
  },
  "note": "Dang duoc muon boi bo phan mau de may mau fitting"
}
```

### Asset 5 - May dinh bo

```json
{
  "name": "May dinh bo Juki LK-1900B",
  "machineCode": "MM005",
  "serial": "JUKI-LK1900B-240005",
  "type": "May dinh bo",
  "brandId": "{{brand_juki_id}}",
  "plantId": "{{plant_bd_id}}",
  "area": "Khu may chi tiet nho",
  "status": "active",
  "purchaseDate": "2024-01-28",
  "purchasePrice": 28600000,
  "specifications": {
    "ungDung": "Dinh bo, bartack tai vi tri tui va dai quan",
    "chuongTrinhMay": "Lap trinh mau dinh bo"
  },
  "note": "May cho line quan kaki"
}
```

### Asset 6 - May thua khuy

```json
{
  "name": "May thua khuy dien tu Brother HE-800C",
  "machineCode": "MM006",
  "serial": "BROTHER-HE800C-240006",
  "type": "May thua khuy",
  "brandId": "{{brand_brother_id}}",
  "plantId": "{{plant_bd_id}}",
  "area": "Khu hoan thien ao so mi",
  "status": "storage",
  "purchaseDate": "2023-12-18",
  "purchasePrice": 33400000,
  "specifications": {
    "ungDung": "Thua khuy ao so mi, dong phuc",
    "kichThuocKhuy": "6-38 mm"
  },
  "note": "May du phong dang luu kho"
}
```

### Asset 7 - May cat vai dung

```json
{
  "name": "May cat vai dung KM RS-100",
  "machineCode": "MM007",
  "serial": "KM-RS100-240007",
  "type": "May cat vai dung",
  "brandId": "{{brand_pegasus_id}}",
  "plantId": "{{plant_kho_id}}",
  "area": "Khu cat vai du phong",
  "status": "broken",
  "purchaseDate": "2022-08-12",
  "purchasePrice": 9700000,
  "specifications": {
    "ungDung": "Cat vai so luong nho",
    "daoCat": "8 inch"
  },
  "note": "Hong cong tac an toan, tam dung su dung"
}
```

### Asset 8 - Ban ui hoi cong nghiep

```json
{
  "name": "Ban ui hoi cong nghiep Silver Star",
  "machineCode": "MM008",
  "serial": "SSTAR-IRON-240008",
  "type": "Ban ui hoi cong nghiep",
  "brandId": "{{brand_jack_id}}",
  "plantId": "{{plant_hcm_id}}",
  "area": "Khu hoan thien",
  "status": "active",
  "purchaseDate": "2024-04-02",
  "purchasePrice": 6800000,
  "specifications": {
    "ungDung": "Ui phang thanh pham truoc dong goi",
    "nguonHoi": "Noi hoi trung tam"
  },
  "note": "Thiet bi ho tro cong doan hoan thien"
}
```

## 7. Maintenances

`POST {{baseUrl}}/maintenances`

### Maintenance 1

```json
{
  "assetId": "{{asset_mm002_id}}",
  "type": "emergency",
  "description": "Thay dao cat chi va can chinh cum moc cho may vat so 4 chi",
  "startDate": "2026-04-20",
  "technician": "Nguyen Van Ky",
  "cost": 850000,
  "note": "May bi bo mui va dut chi lien tuc"
}
```

### Maintenance 2

```json
{
  "assetId": "{{asset_mm001_id}}",
  "type": "periodic",
  "description": "Bao tri dinh ky, ve sinh bo chap, thay dau boi tron",
  "startDate": "2026-04-15",
  "endDate": "2026-04-15",
  "technician": "Nguyen Van Ky",
  "cost": 250000,
  "note": "Hoan tat trong ngay"
}
```

### Maintenance 3

```json
{
  "assetId": "{{asset_mm007_id}}",
  "type": "inspection",
  "description": "Kiem tra loi cong tac an toan va day nguon may cat vai",
  "startDate": "2026-04-18",
  "technician": "To bao tri co dien",
  "cost": 0,
  "note": "Dang cho thay linh kien"
}
```

## 8. Transfers

`POST {{baseUrl}}/transfers`

### Transfer 1

```json
{
  "assetId": "{{asset_mm006_id}}",
  "fromPlantId": "{{plant_kho_id}}",
  "toPlantId": "{{plant_bd_id}}",
  "reason": "Dieu chuyen may thua khuy du phong cho line ao so mi xuat khau",
  "transferDate": "2026-04-10",
  "note": "Can giao truoc ngay 12/04"
}
```

### Transfer 2

```json
{
  "assetId": "{{asset_mm003_id}}",
  "fromPlantId": "{{plant_hcm_id}}",
  "toPlantId": "{{plant_bd_id}}",
  "reason": "Ho tro line ao thun tai Binh Duong trong dot cao diem",
  "transferDate": "2026-04-22",
  "note": "Dieu chuyen tam thoi 2 tuan"
}
```

## 9. Borrowings

`POST {{baseUrl}}/borrowings`

### Borrowing 1

```json
{
  "assetId": "{{asset_mm004_id}}",
  "borrowerId": "{{user_ky_thuat_hcm_id}}",
  "borrowDate": "2026-04-21",
  "dueDate": "2026-04-25",
  "purpose": "Muon may 2 kim de may mau jacket cho khach duyet",
  "note": "Muon trong 4 ngay, uu tien tra dung han"
}
```

### Borrowing 2

```json
{
  "assetId": "{{asset_mm008_id}}",
  "borrowerId": "{{user_nhan_vien_kho_id}}",
  "borrowDate": "2026-04-22",
  "dueDate": "2026-04-23",
  "purpose": "Muon ban ui hoi de ho tro buoi chup mau va hoan thien mau trinh khach",
  "note": "Thiet bi nho, co the tra trong ngay"
}
```

## Recommended Postman test script to save IDs

Add this in the `Tests` tab for create requests:

```javascript
const json = pm.response.json();
if (json && json.id) {
  pm.environment.set("last_id", json.id);
}
```

Example for a specific request:

```javascript
const json = pm.response.json();
pm.environment.set("plant_bd_id", json.id);
```

## Quick map for variables after each request

- Plant 1 -> `plant_bd_id`
- Plant 2 -> `plant_hcm_id`
- Plant 3 -> `plant_kho_id`
- Brand Juki -> `brand_juki_id`
- Brand Brother -> `brand_brother_id`
- Brand Jack -> `brand_jack_id`
- Brand Siruba -> `brand_siruba_id`
- Brand Pegasus -> `brand_pegasus_id`
- User Tran Van Quan -> `user_quan_doc_bd_id`
- User Nguyen Van Ky -> `user_ky_thuat_hcm_id`
- User Le Thi Kho -> `user_nhan_vien_kho_id`
- Asset MM001 -> `asset_mm001_id`
- Asset MM002 -> `asset_mm002_id`
- Asset MM003 -> `asset_mm003_id`
- Asset MM004 -> `asset_mm004_id`
- Asset MM006 -> `asset_mm006_id`
- Asset MM007 -> `asset_mm007_id`
- Asset MM008 -> `asset_mm008_id`
