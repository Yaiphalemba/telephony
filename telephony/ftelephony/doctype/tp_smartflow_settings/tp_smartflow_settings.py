# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

import frappe
import requests
from frappe.model.document import Document

SMARTFLO_BASE_URL = "https://api-smartflo.tatateleservices.com"

class TPSmartflowSettings(Document):
    def validate(self):
        if self.enabled and self.login_id and self.password:
            self.fetch_and_store_token()

    def fetch_and_store_token(self):
        response = requests.post(
            f"{SMARTFLO_BASE_URL}/v1/auth/login",
            json={"email": self.login_id, "password": self.get_password("password")},
            headers={"Accept": "application/json", "Content-Type": "application/json"}
        )
        data = response.json()
        if data.get("success"):
            self.access_token = data["access_token"]
            # token_type is "bearer", expires_in is 3600 seconds
            from frappe.utils import add_to_date, now_datetime
            self.token_expiry = add_to_date(now_datetime(), seconds=data.get("expires_in", 3600))
        else:
            frappe.throw(f"Smartflo Auth Failed: {data.get('message', 'Unknown error')}")

    def get_valid_token(self):
        """Return a valid token, refreshing if expired."""
        from frappe.utils import now_datetime
        if not self.access_token or (self.token_expiry and now_datetime() >= self.token_expiry):
            self.fetch_and_store_token()
        return self.get_password("access_token")

def get_smartflo_settings():
    return frappe.get_single("TP Smartflow Settings")