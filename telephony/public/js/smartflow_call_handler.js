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


// ==========================================
// GLOBAL NAVBAR DIALER (MANUAL ENTRY)
// ==========================================

$(document).on('app_ready', function() {
    frappe.xcall('telephony.smartflow.handler.is_integration_enabled')
        .then(is_enabled => {
            if (is_enabled) {
                let $dialer_btn = $(`
                    <li class="nav-item">
                        <button class="btn btn-sm btn-default" title="Manual Dial" onclick="open_manual_dialer()" style="margin-top: 4px; margin-right: 15px; border-radius: 20px; padding: 4px 15px; display: flex; align-items: center; gap: 5px;">
                            <svg class="icon icon-sm"><use href="#icon-call"></use></svg> Dial
                        </button>
                    </li>
                `);
                
                // Target the right-side navbar dynamically (handles both v14 and v15)
                let $target = $('ul.navbar-nav').last();
                if ($target.length) {
                    $target.prepend($dialer_btn);
                } else {
                    $('.navbar-right').prepend($dialer_btn); // Fallback
                }
            }
        })
        .catch(err => {
            console.error("Smartflow Integration Check Failed:", err);
        });
});

window.open_manual_dialer = function() {
    let history_offset = 0;
    let contacts_offset = 0;

    let dialer_dialog = new frappe.ui.Dialog({
        title: __('Smartflow Dialer'),
        fields: [
            {
                fieldname: 'dialer_html',
                fieldtype: 'HTML',
                options: `
                    <div class="dialer-tabs-container">
                        <!-- TAB NAVIGATION -->
                        <ul class="nav nav-pills nav-justified mb-3" style="border-bottom: 1px solid var(--border-color); padding-bottom: 10px;">
                            <li class="nav-item"><a class="nav-link active" data-tab="dialpad" href="javascript:void(0)">Dialpad</a></li>
                            <li class="nav-item"><a class="nav-link" data-tab="history" href="javascript:void(0)">History</a></li>
                            <li class="nav-item"><a class="nav-link" data-tab="contacts" href="javascript:void(0)">Contacts</a></li>
                        </ul>
                        
                        <!-- 1. DIALPAD TAB -->
                        <div class="dialer-tab-content active" id="tab-dialpad">
                            <div class="form-group">
                                <label class="text-muted" style="font-size: 12px;">Enter Phone Number</label>
                                <input type="text" class="form-control" id="manual_dial_number" placeholder="e.g. 919876543210" style="margin-bottom: 15px; font-size: 16px; padding: 10px;">
                            </div>
                            <button class="btn btn-primary w-100" id="btn_trigger_call" style="margin-bottom: 10px; padding: 8px;">
                                <svg class="icon icon-sm"><use href="#icon-call"></use></svg> Dial Number
                            </button>
                            <div id="dialer_status" style="font-weight: 500; font-size: 13px; text-align: center;"></div>
                        </div>
                        
                        <!-- 2. HISTORY TAB -->
                        <div class="dialer-tab-content" id="tab-history" style="display: none;">
                            <ul id="history_list" style="list-style: none; padding: 0; margin: 0; max-height: 280px; overflow-y: auto;"></ul>
                            <button class="btn btn-xs btn-default w-100 mt-2" id="btn_load_more_history" style="display: none;">Load More</button>
                        </div>
                        
                        <!-- 3. CONTACTS TAB -->
                        <div class="dialer-tab-content" id="tab-contacts" style="display: none;">
                            <div class="mb-2 text-muted" style="font-size: 11px; text-align: right;">Showing contacts with valid numbers</div>
                            <ul id="contacts_list" style="list-style: none; padding: 0; margin: 0; max-height: 250px; overflow-y: auto;"></ul>
                            <button class="btn btn-xs btn-default w-100 mt-2" id="btn_load_more_contacts" style="display: none;">Load More</button>
                        </div>
                    </div>
                `
            }
        ]
    });
    
    // Hide standard bottom Frappe actions to make it look like a sleek widget
    dialer_dialog.get_primary_btn().parent().hide(); 
    dialer_dialog.show();

    let $wrapper = dialer_dialog.$wrapper;

    // ==========================================
    // UI ROUTING (TAB SWITCHING)
    // ==========================================
    $wrapper.find('.nav-link').on('click', function() {
        $wrapper.find('.nav-link').removeClass('active');
        $(this).addClass('active');
        
        let target = $(this).attr('data-tab');
        $wrapper.find('.dialer-tab-content').hide();
        $wrapper.find('#tab-' + target).fadeIn(150);
        
        // Lazy load the data so we don't bombard the database on open
        if (target === 'history' && history_offset === 0) load_history();
        if (target === 'contacts' && contacts_offset === 0) load_contacts();
    });

    // ==========================================
    // CORE CALLING LOGIC
    // ==========================================
    $wrapper.find('#btn_trigger_call').on('click', function() {
        let to_number = $wrapper.find('#manual_dial_number').val().trim();
        if (!to_number) {
            frappe.msgprint("Please enter a number first.");
            return;
        }
        
        $(this).prop('disabled', true);
        $wrapper.find('#dialer_status').html('<span style="color: #f39c12;">Ringing your softphone...</span>');

        frappe.xcall('telephony.smartflow.handler.make_a_call', {
            'to_number': to_number
        }).then(res => {
            $wrapper.find('#dialer_status').html('<span style="color: #27ae60;">Call bridged! Connecting to customer...</span>');
            
            let call_id = res.CallSid || res.call_id || (res.data ? res.data.call_id : null);
            if (call_id) {
                let status_interval = setInterval(() => {
                    frappe.db.get_value('TP Call Log', call_id, 'status')
                    .then(r => {
                        if (r.message && r.message.status) {
                            let current_status = r.message.status;
                            $wrapper.find('#dialer_status').html(`<span style="color: #3498db;">Live Status: ${current_status}</span>`);
                            
                            if (['Completed', 'Failed', 'Busy', 'No Answer', 'Canceled', 'Missed'].includes(current_status)) {
                                clearInterval(status_interval);
                                $wrapper.find('#dialer_status').append('<br><br><span style="color: #27ae60; font-weight: bold;">Call Finished.</span>');
                                $wrapper.find('#btn_trigger_call').prop('disabled', false); 
                                
                                // Reset history so next time they open the tab, it shows this call
                                history_offset = 0; 
                            }
                        }
                    });
                }, 1500); 
                
                dialer_dialog.$wrapper.on('hidden.bs.modal', () => clearInterval(status_interval));
            }
        }).catch(e => {
            $wrapper.find('#btn_trigger_call').prop('disabled', false);
            $wrapper.find('#dialer_status').html('<span style="color: #e74c3c;">Failed to initiate call. Check console.</span>');
        });
    });

    // ==========================================
    // HISTORY DATA LOADER (INBOUND & OUTBOUND)
    // ==========================================
    function load_history(append = false) {
        if (!append) $wrapper.find('#history_list').html('<li class="text-muted text-center py-3">Loading History...</li>');
        
        frappe.call({
            method: 'frappe.client.get_list',
            args: {
                doctype: 'TP Call Log',
                fields: ['name', 'to', 'from', 'status', 'creation', 'type'],
                or_filters: [
                    ['caller', '=', frappe.session.user],
                    ['receiver', '=', frappe.session.user]
                ],
                limit_page_length: 20,
                limit_start: history_offset,
                order_by: 'creation desc'
            },
            callback: function(r) {
                let records = r.message || [];
                let html = '';
                
                if (records.length === 0 && !append) {
                    html = '<li class="text-muted text-center py-3">No recent calls found.</li>';
                    $wrapper.find('#btn_load_more_history').hide();
                } else {
                    records.forEach(r => {
                        // Determine the direction to format the UI properly
                        let is_incoming = r.type === 'Incoming';
                        
                        // If it's incoming, the customer's number is 'from'. If outgoing, it's 'to'.
                        let customer_num = is_incoming ? r.from : r.to;
                        
                        // Sleek UI badges for direction
                        let type_badge = is_incoming 
                            ? '<span style="color: #27ae60; border: 1px solid #27ae60; padding: 1px 4px; border-radius: 3px; font-size: 9px; margin-right: 5px;">IN</span>'
                            : '<span style="color: #3498db; border: 1px solid #3498db; padding: 1px 4px; border-radius: 3px; font-size: 9px; margin-right: 5px;">OUT</span>';
                            
                        let color = ['Completed', 'In Progress'].includes(r.status) ? 'green' : (r.status === 'Failed' ? 'red' : 'orange');
                        
                        html += `
                            <li style="padding: 10px 0; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center;">
                                <div>
                                    <div style="font-weight: 500; display: flex; align-items: center;">
                                        ${type_badge} ${customer_num || 'Unknown'}
                                    </div>
                                    <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">
                                        ${frappe.datetime.comment_when(r.creation)}
                                    </div>
                                </div>
                                <div style="text-align: right;">
                                    <span class="indicator ${color}" style="font-size: 11px; margin-bottom: 5px; display: block;">${r.status}</span>
                                    <button class="btn btn-xs btn-default btn-fill-dialer" data-num="${customer_num}">Call</button>
                                </div>
                            </li>
                        `;
                    });
                    
                    records.length < 20 ? $wrapper.find('#btn_load_more_history').hide() : $wrapper.find('#btn_load_more_history').show();
                }
                
                append ? $wrapper.find('#history_list').append(html) : $wrapper.find('#history_list').html(html);
            }
        });
    }

    // ==========================================
    // CONTACTS DATA LOADER
    // ==========================================
    function load_contacts(append = false) {
        if (!append) $wrapper.find('#contacts_list').html('<li class="text-muted text-center py-3">Loading Contacts...</li>');
        
        frappe.call({
            method: 'frappe.client.get_list',
            args: {
                doctype: 'Contact',
                fields: ['name', 'first_name', 'last_name', 'phone', 'mobile_no'],
                or_filters: [
                    ['phone', 'is', 'set'],
                    ['mobile_no', 'is', 'set']
                ],
                limit_page_length: 20,
                limit_start: contacts_offset,
                order_by: 'creation desc'
            },
            callback: function(r) {
                let records = r.message || [];
                let html = '';
                
                if (records.length === 0 && !append) {
                    html = '<li class="text-muted text-center py-3">No contacts with phone numbers found.</li>';
                    $wrapper.find('#btn_load_more_contacts').hide();
                } else {
                    records.forEach(c => {
                        let full_name = $.trim(`${c.first_name || ''} ${c.last_name || ''}`);
                        let phone_to_show = c.mobile_no || c.phone; 
                        
                        html += `
                            <li style="padding: 10px 0; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center;">
                                <div>
                                    <div style="font-weight: 500;">${full_name || c.name}</div>
                                    <div style="font-size: 12px; color: var(--text-muted);">
                                        <svg class="icon icon-xs"><use href="#icon-call"></use></svg> ${phone_to_show}
                                    </div>
                                </div>
                                <button class="btn btn-xs btn-default btn-fill-dialer" data-num="${phone_to_show}">Call</button>
                            </li>
                        `;
                    });
                    
                    records.length < 20 ? $wrapper.find('#btn_load_more_contacts').hide() : $wrapper.find('#btn_load_more_contacts').show();
                }
                
                append ? $wrapper.find('#contacts_list').append(html) : $wrapper.find('#contacts_list').html(html);
            }
        });
    }

    // ==========================================
    // EVENT BINDINGS
    // ==========================================
    $wrapper.find('#btn_load_more_history').on('click', function() {
        history_offset += 20;
        load_history(true);
    });

    $wrapper.find('#btn_load_more_contacts').on('click', function() {
        contacts_offset += 20;
        load_contacts(true);
    });

    // Auto-fill the Dialpad when they click "Call" from History or Contacts
    $wrapper.on('click', '.btn-fill-dialer', function() {
        let num = $(this).attr('data-num');
        $wrapper.find('#manual_dial_number').val(num);
        
        // Jump back to the dialpad tab
        $wrapper.find('.nav-link[data-tab="dialpad"]').click();
        
        // Sexy little flash animation to prove it copied
        $wrapper.find('#manual_dial_number').fadeOut(100).fadeIn(100).focus();
    });

    setTimeout(() => {
        $wrapper.find('input[id="manual_dial_number"]').focus();
    }, 300);
};