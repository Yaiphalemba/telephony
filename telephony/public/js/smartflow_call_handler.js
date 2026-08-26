frappe.provide('frappe.phone_call');

class SmartflowCallHandler {
    constructor(to_number, frm) {
        // Handles string or array inputs[cite: 1]
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

// Check if Smartflow is enabled, then override the default Frappe click-to-call UI[cite: 1]
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
                // // Catch the custom event you broadcasted from Python
                // frappe.realtime.on('smartflow_incoming_call', function(data) {
                //     console.log("Incoming Call detected!", data);
                    
                //     // Automatically open your custom dialer
                //     if (typeof window.open_manual_dialer === 'function') {
                //         window.open_manual_dialer();
                        
                //         // Optional: Force it to the dialpad tab if you want to show active call state immediately
                //         $('.nav-link[data-tab="dialpad"]').click(); 
                //     }
                // });
            }
        })
        .catch(err => {
            console.error("Smartflow Integration Check Failed:", err);
        });
});

// Hoist the cache so we don't query the database repeatedly for the same numbers
window.smartflow_contact_cache = window.smartflow_contact_cache || {};
window.smartflow_active_call_id = window.smartflow_active_call_id || null;

window.open_manual_dialer = function() {
    let history_offset = 0;
    let contacts_offset = 0;
    let history_search_term = '';
    let contacts_search_term = '';
    let h_timer;
    let c_timer;

    window.smartflow_dialer_dialog = new frappe.ui.Dialog({
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
                                <input type="text" class="form-control" id="manual_dial_number" placeholder="e.g. 919876543210" style="margin-bottom: 5px; font-size: 16px; padding: 10px;">
                                <!-- NEW: Dedicated space to show the Contact's Name during a call -->
                                <div id="active_contact_name" class="text-primary mb-2" style="font-size: 13px; text-align: center; font-weight: 600; min-height: 20px;"></div>
                            </div>
                            <button class="btn btn-primary w-100" id="btn_trigger_call" style="margin-bottom: 10px; padding: 8px;">
                                <svg class="icon icon-sm"><use href="#icon-call"></use></svg> Dial Number
                            </button>
                            <div id="dialer_status" style="font-weight: 500; font-size: 13px; text-align: center;"></div>
                        </div>
                        
                        <!-- 2. HISTORY TAB -->
                        <div class="dialer-tab-content" id="tab-history" style="display: none;">
                            <input type="text" class="form-control form-control-sm mb-2" id="search_history" placeholder="Search number or status...">
                            <ul id="history_list" style="list-style: none; padding: 0; margin: 0; max-height: 250px; overflow-y: auto;"></ul>
                            <button class="btn btn-xs btn-default w-100 mt-2" id="btn_load_more_history" style="display: none;">Load More</button>
                        </div>
                        
                        <!-- 3. CONTACTS TAB -->
                        <div class="dialer-tab-content" id="tab-contacts" style="display: none;">
                            <input type="text" class="form-control form-control-sm mb-2" id="search_contacts" placeholder="Search name or number...">
                            <div class="mb-2 text-muted" style="font-size: 11px; text-align: right;">Showing contacts with valid numbers</div>
                            <ul id="contacts_list" style="list-style: none; padding: 0; margin: 0; max-height: 220px; overflow-y: auto;"></ul>
                            <button class="btn btn-xs btn-default w-100 mt-2" id="btn_load_more_contacts" style="display: none;">Load More</button>
                        </div>
                    </div>
                `
            }
        ]
    });
    
    let dialer_dialog = window.smartflow_dialer_dialog;
    dialer_dialog.get_primary_btn().parent().hide(); 
    dialer_dialog.show();

    let $wrapper = dialer_dialog.$wrapper;

    // ==========================================
    // THE SMART CONTACT CACHE
    // ==========================================
    function resolve_contacts(numbers_array, callback) {
        let unique_nums = [...new Set(numbers_array.filter(Boolean))];
        let missing_nums = unique_nums.filter(n => window.smartflow_contact_cache[n] === undefined);

        if (missing_nums.length === 0) {
            return callback();
        }

        frappe.call({
            method: 'frappe.client.get_list',
            args: {
                doctype: 'Contact',
                fields: ['name', 'first_name', 'last_name', 'phone', 'mobile_no'],
                or_filters: [
                    ['phone', 'in', missing_nums],
                    ['mobile_no', 'in', missing_nums]
                ]
            },
            callback: function(r) {
                let contacts = r.message || [];
                
                // Mark all searched numbers as null first so we don't repeatedly search unknowns
                missing_nums.forEach(m => window.smartflow_contact_cache[m] = null);
                
                contacts.forEach(c => {
                    let full_name = $.trim(`${c.first_name || ''} ${c.last_name || ''}`) || c.name;
                    if (c.phone) window.smartflow_contact_cache[c.phone] = full_name;
                    if (c.mobile_no) window.smartflow_contact_cache[c.mobile_no] = full_name;
                });
                
                callback();
            }
        });
    }

    // ==========================================
    // STATE RECOVERY (With Names!)
    // ==========================================
    function resume_active_call(call_id, known_number = null) {
        $wrapper.find('#btn_trigger_call').prop('disabled', true);
        $wrapper.find('#dialer_status').html('<span style="color: #f39c12;">Tracking active call session...</span>');
        
        let populate_and_resolve = (num) => {
            $wrapper.find('#manual_dial_number').val(num);
            resolve_contacts([num], () => {
                let name = window.smartflow_contact_cache[num];
                if (name) {
                    $wrapper.find('#active_contact_name').html(`<svg class="icon icon-sm"><use href="#icon-user"></use></svg> ${name}`);
                }
            });
        };

        if (known_number) {
            populate_and_resolve(known_number);
        } else {
            frappe.db.get_value('TP Call Log', call_id, ['to', 'from', 'type'])
            .then(r => {
                if (r.message) {
                    let customer_num = r.message.type === 'Incoming' ? r.message.from : r.message.to;
                    if (customer_num) populate_and_resolve(customer_num);
                }
            });
        }
        
        start_call_polling(call_id);
    }

    if (window.smartflow_active_call_id) {
        resume_active_call(window.smartflow_active_call_id);
    } else {
        frappe.call({
            method: 'frappe.client.get_list',
            args: {
                doctype: 'TP Call Log',
                fields: ['name', 'to', 'from', 'type', 'status'],
                or_filters: [
                    ['caller', '=', frappe.session.user],
                    ['receiver', '=', frappe.session.user]
                ],
                limit_page_length: 1,
                order_by: 'creation desc'
            },
            callback: function(r) {
                if (r.message && r.message.length > 0) {
                    let latest_call = r.message[0];
                    if (['Ringing', 'In Progress', 'Initiated'].includes(latest_call.status)) {
                        let customer_num = latest_call.type === 'Incoming' ? latest_call.from : latest_call.to;
                        resume_active_call(latest_call.name, customer_num);
                    }
                }
            }
        });
    }

    // ==========================================
    // UI ROUTING (TAB SWITCHING)
    // ==========================================
    $wrapper.find('.nav-link').on('click', function() {
        $wrapper.find('.nav-link').removeClass('active');
        $(this).addClass('active');
        
        let target = $(this).attr('data-tab');
        $wrapper.find('.dialer-tab-content').hide();
        $wrapper.find('#tab-' + target).fadeIn(150);
        
        if (target === 'history' && history_offset === 0 && !history_search_term) load_history();
        if (target === 'contacts' && contacts_offset === 0 && !contacts_search_term) load_contacts();
    });

    // Clear the active name when they type a new number manually
    $wrapper.find('#manual_dial_number').on('input', function() {
        $wrapper.find('#active_contact_name').html('');
    });

    // ==========================================
    // SEARCH EVENT LISTENERS
    // ==========================================
    $wrapper.find('#search_history').on('input', function() {
        clearTimeout(h_timer);
        history_search_term = $(this).val().trim();
        history_offset = 0;
        h_timer = setTimeout(() => load_history(), 300);
    });

    $wrapper.find('#search_contacts').on('input', function() {
        clearTimeout(c_timer);
        contacts_search_term = $(this).val().trim();
        contacts_offset = 0;
        c_timer = setTimeout(() => load_contacts(), 300);
    });

    // ==========================================
    // CORE CALLING & POLLING LOGIC
    // ==========================================
    function start_call_polling(call_id) {
        window.smartflow_active_call_id = call_id;
        
        let status_interval = setInterval(() => {
            frappe.db.get_value('TP Call Log', call_id, 'status')
            .then(r => {
                if (r.message && r.message.status) {
                    let current_status = r.message.status;
                    $wrapper.find('#dialer_status').html(`<span style="color: #3498db;">Live Status: ${current_status}</span>`);
                    
                    if (['Completed', 'Failed', 'Busy', 'No Answer', 'Canceled', 'Missed'].includes(current_status)) {
                        clearInterval(status_interval);
                        window.smartflow_active_call_id = null;
                        
                        $wrapper.find('#dialer_status').append('<br><br><span style="color: #27ae60; font-weight: bold;">Call Finished.</span>');
                        $wrapper.find('#btn_trigger_call').prop('disabled', false); 
                        history_offset = 0; 
                    }
                }
            });
        }, 1500); 
        
        dialer_dialog.$wrapper.on('hidden.bs.modal', () => clearInterval(status_interval));
    }

    $wrapper.find('#btn_trigger_call').on('click', function() {
        let to_number = $wrapper.find('#manual_dial_number').val().trim();
        if (!to_number) {
            frappe.msgprint("Please enter a number first.");
            return;
        }
        
        $(this).prop('disabled', true);
        $wrapper.find('#dialer_status').html('<span style="color: #f39c12;">Ringing your softphone...</span>');

        // Resolve the name on the fly if they typed it manually
        resolve_contacts([to_number], () => {
            let name = window.smartflow_contact_cache[to_number];
            if (name) {
                $wrapper.find('#active_contact_name').html(`<svg class="icon icon-sm"><use href="#icon-user"></use></svg> ${name}`);
            }
        });

        frappe.xcall('telephony.smartflow.handler.make_a_call', {
            'to_number': to_number
        }).then(res => {
            $wrapper.find('#dialer_status').html('<span style="color: #27ae60;">Call bridged! Connecting to customer...</span>');
            
            let call_id = res.CallSid || res.call_id || (res.data ? res.data.call_id : null);
            if (call_id) {
                start_call_polling(call_id);
            }
        }).catch(e => {
            $wrapper.find('#btn_trigger_call').prop('disabled', false);
            $wrapper.find('#dialer_status').html('<span style="color: #e74c3c;">Failed to initiate call. Check console.</span>');
        });
    });

    // ==========================================
    // HISTORY DATA LOADER (With Names!)
    // ==========================================
    function load_history(append = false) {
        if (!append) $wrapper.find('#history_list').html('<li class="text-muted text-center py-3">Loading History...</li>');
        
        let args = {
            doctype: 'TP Call Log',
            fields: ['name', 'to', 'from', 'status', 'creation', 'type', 'caller', 'receiver'],
            limit_page_length: history_search_term ? 100 : 20, 
            limit_start: history_offset,
            order_by: 'creation desc'
        };

        if (history_search_term) {
            args.or_filters = [
                ['to', 'like', `%${history_search_term}%`],
                ['from', 'like', `%${history_search_term}%`],
                ['status', 'like', `%${history_search_term}%`]
            ];
        } else {
            args.or_filters = [
                ['caller', '=', frappe.session.user],
                ['receiver', '=', frappe.session.user]
            ];
        }

        frappe.call({
            method: 'frappe.client.get_list',
            args: args,
            callback: function(r) {
                let raw_records = r.message || [];
                let records = history_search_term 
                    ? raw_records.filter(c => c.caller === frappe.session.user || c.receiver === frappe.session.user)
                    : raw_records;

                if (records.length === 0 && !append) {
                    $wrapper.find('#history_list').html('<li class="text-muted text-center py-3">No matching calls found.</li>');
                    $wrapper.find('#btn_load_more_history').hide();
                    return;
                }

                // 🚨 Before rendering HTML, resolve all numbers!
                let numbers_to_resolve = records.map(r => r.type === 'Incoming' ? r.from : r.to);
                
                resolve_contacts(numbers_to_resolve, () => {
                    let html = '';
                    
                    records.forEach(r => {
                        let is_incoming = r.type === 'Incoming';
                        let customer_num = is_incoming ? r.from : r.to;
                        let contact_name = window.smartflow_contact_cache[customer_num];
                        
                        let display_title = contact_name 
                            ? `<span style="font-weight: 600;">${contact_name}</span> <span style="font-size: 11px; color: var(--text-muted);">(${customer_num})</span>`
                            : `<span style="font-weight: 500;">${customer_num || 'Unknown'}</span>`;
                        
                        let type_badge = is_incoming 
                            ? '<span style="color: #27ae60; border: 1px solid #27ae60; padding: 1px 4px; border-radius: 3px; font-size: 9px; margin-right: 5px;">IN</span>'
                            : '<span style="color: #3498db; border: 1px solid #3498db; padding: 1px 4px; border-radius: 3px; font-size: 9px; margin-right: 5px;">OUT</span>';
                        let color = ['Completed', 'In Progress'].includes(r.status) ? 'green' : (r.status === 'Failed' ? 'red' : 'orange');
                        
                        html += `
                            <li style="padding: 10px 0; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center;">
                                <div>
                                    <div style="display: flex; align-items: center;">
                                        ${type_badge} ${display_title}
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
                    
                    records.length < (history_search_term ? 100 : 20) ? $wrapper.find('#btn_load_more_history').hide() : $wrapper.find('#btn_load_more_history').show();
                    append ? $wrapper.find('#history_list').append(html) : $wrapper.find('#history_list').html(html);
                });
            }
        });
    }

    // ==========================================
    // CONTACTS DATA LOADER
    // ==========================================
    function load_contacts(append = false) {
        if (!append) $wrapper.find('#contacts_list').html('<li class="text-muted text-center py-3">Loading Contacts...</li>');
        
        let args = {
            doctype: 'Contact',
            fields: ['name', 'first_name', 'last_name', 'phone', 'mobile_no'],
            limit_page_length: 20,
            limit_start: contacts_offset,
            order_by: 'creation desc'
        };

        if (contacts_search_term) {
            args.or_filters = [
                ['name', 'like', `%${contacts_search_term}%`],
                ['first_name', 'like', `%${contacts_search_term}%`],
                ['last_name', 'like', `%${contacts_search_term}%`],
                ['phone', 'like', `%${contacts_search_term}%`],
                ['mobile_no', 'like', `%${contacts_search_term}%`]
            ];
        } else {
            args.or_filters = [
                ['phone', 'is', 'set'],
                ['mobile_no', 'is', 'set']
            ];
        }

        frappe.call({
            method: 'frappe.client.get_list',
            args: args,
            callback: function(r) {
                let records = r.message || [];
                let html = '';
                let valid_count = 0;
                
                if (records.length === 0 && !append) {
                    html = '<li class="text-muted text-center py-3">No matching contacts found.</li>';
                    $wrapper.find('#btn_load_more_contacts').hide();
                } else {
                    records.forEach(c => {
                        let full_name = $.trim(`${c.first_name || ''} ${c.last_name || ''}`);
                        let phone_to_show = c.mobile_no || c.phone; 
                        
                        if (!phone_to_show) return;
                        valid_count++;
                        
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
                    
                    if (valid_count === 0 && !append) {
                        html = '<li class="text-muted text-center py-3">No matching contacts with phone numbers found.</li>';
                    }
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
        history_offset += (history_search_term ? 100 : 20);
        load_history(true);
    });

    $wrapper.find('#btn_load_more_contacts').on('click', function() {
        contacts_offset += 20;
        load_contacts(true);
    });

    $wrapper.on('click', '.btn-fill-dialer', function() {
        let num = $(this).attr('data-num');
        $wrapper.find('#manual_dial_number').val(num);
        
        // Check cache to instantly populate the name space
        let name = window.smartflow_contact_cache[num];
        if (name) {
            $wrapper.find('#active_contact_name').html(`<svg class="icon icon-sm"><use href="#icon-user"></use></svg> ${name}`);
        } else {
            $wrapper.find('#active_contact_name').html('');
        }
        
        $wrapper.find('.nav-link[data-tab="dialpad"]').click();
        $wrapper.find('#manual_dial_number').fadeOut(100).fadeIn(100).focus();
    });

    setTimeout(() => {
        if (!window.smartflow_active_call_id) {
            $wrapper.find('input[id="manual_dial_number"]').focus();
        }
    }, 300);
};