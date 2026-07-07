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
        status = call_payload.get("status")
        
        # Drop junk/ping events early
        if status == "free" or not call_payload.get("call_id"):
            return

        # 1. Get or create the call log
        if call_log_doc := get_call_log(call_payload):
            call_log_doc = update_call_log(call_payload, call_log=call_log_doc)
        else:
            # Detect Tata's specific softphone directions
            raw_dir = call_payload.get("direction", "inbound").lower()
            call_type = "Outgoing" if raw_dir in ["outbound", "clicktocall", "click_to_call"] else "Incoming"

            # Safely extract numbers
            from_num = call_payload.get("caller_id_number") or call_payload.get("customer_number")
            to_num = call_payload.get("call_to_number") or call_payload.get("display_number")
            
            # Find the Agent dynamically based on direction
            agent_num = call_payload.get("agent_number")
            if not agent_num and isinstance(call_payload.get("answered_agent"), dict):
                agent_num = call_payload["answered_agent"].get("agent_number")
            if not agent_num and isinstance(call_payload.get("answered_agent_number"), dict):
                agent_num = call_payload["answered_agent_number"].get("follow_me_number")

            if not agent_num:
                lookup_num = from_num if call_type == "Outgoing" else to_num
                agent_user = frappe.db.get_value("TP Telephony Agent", {"smartflow_number": lookup_num}, "user")
                if agent_user:
                    agent_num = agent_user 

            # RACE CONDITION ARMOR: Catch concurrent duplicate insert attempts gracefully
            try:
                call_log_doc = create_call_log(
                    call_id=call_payload.get("call_id"),
                    from_number=from_num,
                    to_number=to_num,
                    medium="Smartflow",
                    status=get_call_log_status(call_payload),
                    agent=agent_num,
                    call_type=call_type
                )
            except frappe.DuplicateEntryError:
                # The parallel webhook thread beat us to the insert! 
                # Bypass creation, fetch their fresh record, and update it with our hangup data.
                frappe.db.rollback() # Clear the failed insert state
                call_log_doc = get_call_log(call_payload)
                if call_log_doc:
                    call_log_doc = update_call_log(call_payload, call_log=call_log_doc)

            # Map the Start Time immediately if we have a valid doc
            if call_log_doc and (start_stamp := call_payload.get("start_stamp")):
                call_log_doc.start_time = start_stamp
                call_log_doc.save(ignore_permissions=True)
                frappe.db.commit()

        # 2. THE MAGIC FIX: Trigger the native ERPNext UI using the exact events it listens for
        if call_log_doc:
            doc_dict = call_log_doc.as_dict()
            internal_status = call_log_doc.status
            
            # PREVENT JS CRASH: call_popup.js absolutely requires a links array
            if "links" not in doc_dict or not doc_dict["links"]:
                doc_dict["links"] = []

            # Always try to route to the actual Agent receiving the call
            target_user = call_log_doc.receiver
            
            # Fallback for manual console testing ONLY
            if not target_user and frappe.session.user != "Guest":
                target_user = frappe.session.user
                
            # If it's an actual call but we couldn't find an Agent profile, log a warning
            if not target_user:
                frappe.logger("telephony").warning(f"Smartflow Popup Failed: No Agent mapped to virtual number {call_log_doc.to}")
            
            # Broadcast to the socket room based on the call lifecycle
            if internal_status in ["Initiated", "Ringing", "In Progress"]:
                frappe.publish_realtime("show_call_popup", doc_dict, user=target_user)
                
            elif internal_status in ["Completed", "Busy", "Failed"]:
                frappe.publish_realtime(f"call_{call_log_doc.id}_ended", doc_dict, user=target_user)
                
            elif internal_status in ["No Answer", "Canceled", "Missed"]:
                frappe.publish_realtime(f"call_{call_log_doc.id}_missed", doc_dict, user=target_user)

    except Exception:
        request_log.status = "Failed"
        request_log.error = frappe.get_traceback()
        frappe.db.rollback()
        frappe.log_error(title="Error while creating/updating Smartflow call record")
        frappe.db.commit()  # nosemgrep
    finally:
        request_log.save(ignore_permissions=True)
        frappe.db.commit()  # nosemgrep


@frappe.whitelist(allow_guest=True)
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

    endpoint = "https://api-smartflo.tatateleservices.com/v1/click_to_call"
    headers = {
        "Authorization": f"Bearer {settings.api_token}",
        "Accept": "application/json",
        "Content-Type": "application/json"
    }

    payload = {
        "agent_number": from_number,
        "destination_number": to_number,
        "get_call_id": 1,
        "caller_id": caller_id,
        "record": 1 if record_call else 0
    }

    try:
        # Changed timeout to 30 seconds to account for Tata's backend lag
        response = requests.post(endpoint, json=payload, headers=headers, timeout=30)
        response.raise_for_status()
        
    except requests.exceptions.ReadTimeout:
        # If Tata takes longer than 30 seconds, don't crash the UI. 
        # Assume the call is bridging and return a safe fallback.
        frappe.logger("telephony").warning("Smartflow Click-to-Call API timed out, but call may still bridge.")
        return {"call_id": "Delayed API Response", "message": "Call initiated..."}
        
    except requests.exceptions.HTTPError:
        if exc := response.json().get("message") or response.json().get("error"):
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

    # 🚨 THE FIX: Safely translate the phone number to a Frappe User Email for ALL calls
    resolved_user = agent
    if agent and "@" not in agent:
        # Try finding the agent by mobile number
        resolved_user = frappe.db.get_value("TP Telephony Agent", {"mobile_no": agent}, "user")
        
        # Fallback to smartflow number if mobile number didn't match
        if not resolved_user:
            resolved_user = frappe.db.get_value("TP Telephony Agent", {"smartflow_number": agent}, "user")
            
    # If we STILL couldn't find an email, prevent the DB crash by leaving it blank
    if resolved_user and "@" not in resolved_user:
        frappe.logger("telephony").warning(f"Smartflow Webhook: No User found mapped to number {agent}")
        resolved_user = None

    # Assign to the correct field based on direction
    if call_type == "Incoming":
        call_log.receiver = resolved_user
    else:
        call_log.caller = resolved_user

    # Link the contact
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


def get_call_log_status(call_payload):
    status = (call_payload.get("call_status") or call_payload.get("status") or "").lower()

    is_terminal_event = bool(
        call_payload.get("hangup_cause_code")
        or call_payload.get("end_stamp")
    )

    if is_terminal_event:
        terminal_map = {
            "answered": "Completed",
            "missed": "No Answer",
        }
        # hangup event — if hangup_cause_code says normal clearing, treat as Completed
        if status:
            return terminal_map.get(status, "Completed")
        return "Completed" if call_payload.get("hangup_cause_key") == "NORMAL_CLEARING" else "No Answer"

    # kept for safety, in case you ever add a live "Call Answered by Agent"
    # (non-hangup) webhook trigger later
    live_map = {
        "answered": "In Progress",
        "in-progress": "In Progress",
        "dialing": "Ringing",
        "ringing": "Ringing",
        "busy": "Busy",
        "no-answer": "No Answer",
        "failed": "Failed",
        "canceled": "Canceled",
    }
    return live_map.get(status, "Initiated")


def update_call_log(call_payload, call_log=None):
    call_log = call_log or get_call_log(call_payload)
    status = get_call_log_status(call_payload)

    try:
        if call_log:
            call_log.status = status
            call_log.duration = frappe.utils.cint(call_payload.get("duration") or call_payload.get("billsec") or 0)
            call_log.recording_url = call_payload.get("recording_url", "")

            if start_stamp := call_payload.get("start_stamp"):
                call_log.start_time = start_stamp
            if end_stamp := call_payload.get("end_stamp"):
                call_log.end_time = end_stamp

            call_log.save(ignore_permissions=True)
            frappe.db.commit()  # nosemgrep
            return call_log
    except Exception:
        frappe.log_error(title="Error while updating Smartflow call record")
        frappe.db.commit()  # nosemgrep