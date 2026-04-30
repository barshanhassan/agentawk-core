# ezconn-core White Label Required Keys

Sirf White Label feature ko chalany k liye apko ye keys zaroori hain:

### 1. Custom Domains (Entri)
Ye keys user k custom domains setup krny k liye use hoti hain.
*   **ENTRI_APPLICATION_ID**: Entri dashboard se application ID.
*   **ENTRI_SECRET**: API authorization k liye secret key.
    *   **Kahan se milegi:** [Entri Dashboard](https://dashboard.goentri.com/) k API settings section se.

### 2. Domains Setup (Your Domains)
Ye wo domains hain jo apny buy kiye huye hain aur system URLs k liye use hongy.
*   **ACCOUNTS_DOMAIN**: Apka default system domain (e.g., accounts.ezconn.io).
*   **ROOT_DOMAIN**: Apka main dashboard domain.
    *   **Kahan se milegi:** Ye apky apny domain registrar (Cloudflare/GoDaddy) se milengi.

### 3. Billing (Chargebee)
White label feature k paise charge krny k liye ye keys zaroori hain.
*   **CHARGEBEE_SITE**: Chargebee dashboard ka site name.
*   **CHARGEBEE_API_KEY**: API access key.
*   **BILLING_BRANDING_ADDON**: White label addon ki ID.
*   **BILLING_WHITELABEL_ADDON_PRICE_ID**: White label addon ki Price ID.
    *   **Kahan se milegi:** [Chargebee Dashboard](https://app.chargebee.com/) mn `Settings -> API Keys` aur `Product Catalog -> Addons` se.

---
**Note:** Ye keys apky gateway se bilkul alag hony chahiyen taakay core ka white-labeling system independent chaly.
