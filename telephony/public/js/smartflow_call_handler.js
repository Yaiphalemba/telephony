frappe.provide('frappe.phone_call');

class SmartflowCallHandler {
	constructor(to_number, frm) {
		// Handles string or array inputs[cite: 9]
		this.to_numbers = Array.isArray(to_number) ? to_number : to_number.split('\n');
		
		if (frm) {
			this.document_to_link = {
				'link_doctype': frm.doctype,
				'link_name': frm.docname
			};
		}
		this.make();
	}

	make() {
		this.dialog = new frappe.ui.Dialog({
			'static': 1,
			'title': __('Make a Call via Smartflow'),
			'minimizable': true,
			'fields': [
				{
					'fieldname': 'to_number',
					'label': 'To Number',
					'fieldtype': 'Autocomplete',
					'default': this.to_numbers[0],
					'ignore_validation': true,
					'options': this.to_numbers,
					'read_only': 0,
					'reqd': 1
				}, 
				{
					'label': 'API Response',
					'fieldtype': 'Section Break',
					'collapsible': 1
				}, 
				{
					'fieldname': 'response',
					'label': 'System Logs',
					'fieldtype': 'Code',
					'read_only': 1
				}
			],
			primary_action: () => {
				this.dialog.disable_primary_action();
				
				// Fire the backend Python script we wrote earlier!
				frappe.xcall('telephony.smartflow.handler.make_a_call', {
					'to_number': this.dialog.get_value('to_number'),
					'link_doctype': this.document_to_link ? this.document_to_link.link_doctype : null,
					'link_docname': this.document_to_link ? this.document_to_link.link_docname : null
				}).then(res => {
					this.dialog.get_close_btn().hide();
					this.dialog.set_value('response', JSON.stringify(res, null, 2));
					
					// Grab the Call ID returned from Tata Smartflow
					this.call_id = res.CallSid || res.call_id; 
					this.setup_call_status_updater();
					
				}).catch(e => {
					this.dialog.enable_primary_action();
					this.dialog.set_value('response', JSON.stringify(e, null, 2));
				});
			},
			primary_action_label: __('Dial Customer')
		});
		
		this.dialog.show();
		this.dialog.get_close_btn().show();
	}

	setup_call_status_updater() {
		if (!this.updater) {
			// Poll the local database every 1.5 seconds instead of hitting Tata's API
			this.updater = setInterval(this.set_call_status.bind(this), 1500);
		}
	}

	set_call_status() {
		frappe.db.get_value('TP Call Log', this.call_id, 'status')
		.then(r => {
			if (r.message && r.message.status) {
				let status = r.message.status;
				this.set_header(status);
				
				// Stop checking if the call hits a terminal state
				if (['Completed', 'Failed', 'Busy', 'No Answer', 'Canceled', 'Missed'].includes(status)) {
					this.set_call_as_complete();
				}
			}
		}).catch(e => {
			console.log("Status Fetch Error:", e);
			this.set_call_as_complete();
		});
	}

	set_call_as_complete() {
		this.dialog.get_close_btn().show();
		clearInterval(this.updater);
	}

	set_header(status) {
		this.dialog.set_title(frappe.model.unscrub(status));
		const indicator_class = this.get_status_indicator(status);
		this.dialog.header.find('.indicator').attr('class', `indicator ${indicator_class}`);
	}

	get_status_indicator(status) {
		const indicator_map = {
			'Completed': 'blue',
			'Failed': 'red',
			'Busy': 'yellow',
			'No Answer': 'orange',
			'Initiated': 'orange',
			'Ringing': 'green blink',
			'In Progress': 'green blink'
		};
		return indicator_map[status] || 'blue blink';
	}
}

// Check if Smartflow is enabled, then override the default Frappe click-to-call UI[cite: 9]
frappe.xcall('telephony.smartflow.handler.is_integration_enabled').then(is_integration_enabled => {
	if (is_integration_enabled) {
		frappe.phone_call.handler = (to_number, frm) => new SmartflowCallHandler(to_number, frm);
	}
});