import bleach
import frappe
import requests
from frappe import _
from frappe.integrations.utils import create_request_log

from telephony.utils import link_call_with_contact, link_call_with_doc

# Incoming Call Webhook:
# <site>/api/method/telephony.smartflow.handler.handle_request?key=<webhook-verify-token>

@frappe.whitelist(allow_guest=True)
def handle_request(**kwargs):
    """Processes inbound webhooks from Tata Smartflow"""
    validate_request()
    if not is_integration_enabled():
        return

    # We use Frappe's native request logging here so you aren't flying blind
    # when webhooks inevitably fail at 2 AM. 
    request_log = create_request_log(
        kwargs,
        request_description="Smartflow Call",
        service_name="Smartflow",
        request_headers=frappe.request.headers,
        is_remote_request=1,
    )

    try:
        request_log.status = "Completed"
        settings = get_smartflow_settings()
        if not settings.enabled:
            return

        call_payload = kwargs

        # This publishes the exact event your frontend needs for the floating popup
        frappe.publish_realtime("smartflow_call", call_payload)  # nosemgrep

        status = call_payload.get("status")
        # Drop junk/ping events early
        if status == "free" or not call_payload.get("call_id"):
            return

        if call_log := get_call_log(call_payload):
            update_call_log(call_payload, call_log=call_log)
        else:
            # Map the inbound keys. Smartflow usually sends 'customer_number' as the client and 'display_number' or 'agent_number' for the agent.
            create_call_log(
                call_id=call_payload.get("call_id"),
                from_number=call_payload.get("customer_number") or call_payload.get("from"),
                to_number=call_payload.get("display_number") or call_payload.get("to"),
                medium=call_payload.get("destination"),
                status=get_call_log_status(call_payload),
                agent=call_payload.get("agent_number"),
            )
    except Exception:
        request_log.status = "Failed"
        request_log.error = frappe.get_traceback()
        frappe.db.rollback()
        frappe.log_error(title="Error while creating/updating Smartflow call record")
        frappe.db.commit()  # nosemgrep
    finally:
        request_log.save(ignore_permissions=True)
        frappe.db.commit()  # nosemgrep


@frappe.whitelist()
def make_a_call(to_number, from_number=None, caller_id=None, link_doctype=None, link_docname=None):
    """Click-to-call execution"""
    if not is_integration_enabled():
        frappe.throw(_("Please setup Smartflow integration"), title=_("Integration Not Enabled"))

    # If the UI doesn't pass the numbers, grab them from the agent's profile
    if not from_number:
        from_number = frappe.get_value("TP Telephony Agent", {"user": frappe.session.user}, "mobile_no")

    if not caller_id:
        caller_id = frappe.get_value("TP Telephony Agent", {"user": frappe.session.user}, "smartflow_number")

    if not caller_id:
        frappe.throw(_("You do not have a Smartflow Number set in your Telephony Agent"), title=_("Smartflow Number Missing"))

    if not from_number:
        frappe.throw(_("You do not have a mobile number set in your Telephony Agent"), title=_("Mobile Number Missing"))

    settings = get_smartflow_settings()
    record_call = settings.record_calls

    endpoint = "https://api.smartflo.tatatelebusiness.com/v1/click_to_call"
    headers = {
        "Authorization": f"Bearer {settings.api_token}",
        "Accept": "application/json",
        "Content-Type": "application/json"
    }

    payload = {
        "agent_number": from_number,
        "customer_number": to_number,
        "caller_id": caller_id,
        "record": 1 if record_call else 0
    }

    try:
        response = requests.post(endpoint, json=payload, headers=headers, timeout=10)
        response.raise_for_status()
    except requests.exceptions.HTTPError:
        if exc := response.json().get("message") or response.json().get("error"):
            # Bleach it just in case the vendor sends back weird HTML inside the error message
            frappe.throw(bleach.linkify(str(exc)), title=_("Smartflow Exception"))
        frappe.throw(_("Failed to connect the call via Tata Smartflow."))
    else:
        res = response.json()
        # Data nesting depends heavily on Tata's exact version, but usually it's in a 'data' block or top-level.
        call_id = res.get("data", {}).get("call_id") or res.get("call_id")

        if call_id:
            create_call_log(
                call_id=call_id,
                from_number=caller_id,
                to_number=to_number,
                medium="Smartflow",
                call_type="Outgoing",
                agent=frappe.session.user,
                link_doc={"doctype": link_doctype, "docname": link_docname},
            )
            
        call_details = res.get("data", res)
        call_details["CallSid"] = call_id
        return call_details


def get_smartflow_settings():
    return frappe.get_single("TP Smartflow Settings")


def validate_request():
    """Security check for inbound webhook payload"""
    webhook_verify_token = frappe.db.get_single_value("TP Smartflow Settings", "webhook_verify_token")
    key = frappe.request.args.get("key")
    
    if not key or key != webhook_verify_token:
        frappe.throw(_("Unauthorized request"), exc=frappe.PermissionError)


@frappe.whitelist()
def is_integration_enabled():
    return frappe.db.get_single_value("TP Smartflow Settings", "enabled", True)


# ---------------------
# Call Log Functions
# ---------------------

def create_call_log(call_id, from_number, to_number, medium, agent, status="Ringing", call_type="Incoming", link_doc=None):
    call_log = frappe.new_doc("TP Call Log")
    call_log.id = call_id
    call_log.to = to_number
    call_log.medium = medium
    call_log.type = call_type
    call_log.status = status
    call_log.telephony_medium = "Smartflow"
    setattr(call_log, "from", from_number)

    # We assign the agent depending on the direction of the call
    if call_type == "Incoming":
        # Resolve user by mobile number if agent is just a phone string
        if agent and "@" not in agent:
            user = frappe.db.get_value("TP Telephony Agent", {"mobile_no": agent}, "user")
            call_log.receiver = user or agent
        else:
            call_log.receiver = agent
    else:
        call_log.caller = agent

    contact_number = from_number if call_type == "Incoming" else to_number
    link_call_with_contact(contact_number, call_log)

    if link_doc and link_doc.get("doctype") and link_doc.get("docname"):
        link_call_with_doc(call_log, link_doc["doctype"], link_doc["docname"])

    call_log.save(ignore_permissions=True)
    frappe.db.commit()  # nosemgrep
    return call_log


def get_call_log(call_payload):
    call_log_id = call_payload.get("call_id")
    if call_log_id and frappe.db.exists("TP Call Log", call_log_id):
        return frappe.get_doc("TP Call Log", call_log_id)


def get_call_log_status(call_payload, direction="inbound"):
    status = call_payload.get("status") or call_payload.get("call_status", "")
    
    status_map = {
        "completed": "Completed",
        "answered": "In Progress",
        "in-progress": "In Progress",
        "dialing": "Ringing",
        "ringing": "Ringing",
        "busy": "Busy",
        "no-answer": "No Answer",
        "failed": "Failed",
        "canceled": "Canceled"
    }
    return status_map.get(status.lower(), "Initiated")


def update_call_log(call_payload, status="Ringing", call_log=None):
    direction = call_payload.get("direction", "incoming")
    call_log = call_log or get_call_log(call_payload)
    status = get_call_log_status(call_payload, direction)
    
    try:
        if call_log:
            call_log.status = status
            
            # Duration mapping
            duration = call_payload.get("duration") or call_payload.get("conversation_duration") or 0
            call_log.duration = frappe.utils.cint(duration)
            
            call_log.recording_url = call_payload.get("recording_url", "")
            
            if start_time := call_payload.get("start_time"):
                call_log.start_time = start_time
            if end_time := call_payload.get("end_time"):
                call_log.end_time = end_time

            call_log.save(ignore_permissions=True)
            frappe.db.commit()  # nosemgrep
            return call_log
    except Exception:
        frappe.log_error(title="Error while updating Smartflow call record")
        frappe.db.commit()  # nosemgrep