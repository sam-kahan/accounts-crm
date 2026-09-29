-- How each scheme takes a NEW complaint by email, from research of each
-- official website on 29 Sep 2026 (search results for the pages named, as
-- the pages themselves could not be opened from where the research ran:
-- confirm each on the live page, Complaints -> Ombudsmen). Only the contact
-- details change: the rules for WHEN a case can go, and whether the record
-- has been checked, are left as they are.
UPDATE ombudsmen SET
  refer_email = 'enquiry@energyombudsman.org',
  refer_email_note = 'Their site says a dispute can be registered via the website, post, email or phone. By email, give the supplier, the account holder, the account number and the date the complaint was first made to the supplier.',
  evidence = evidence || '{"refer_email": {"url": "https://www.energyombudsman.org/additional-support/creating-a-case-with-the-energy-ombudsman", "text": "To begin creating your case via email, you can speak to them via enquiry@energyombudsman.org"}, "refer_methods": {"url": "https://www.energyombudsman.org/raise-dispute", "text": "register your dispute with Energy Ombudsman for free via the website, post, email or telephone."}}'::jsonb,
  updated_at = now()
WHERE key = 'energy_ombudsman' AND refer_email IS NULL;

UPDATE ombudsmen SET
  refer_email = 'admin@tpos.co.uk',
  refer_email_note = 'Send their complaint form, signed, with the supporting documents, and a Letter of Authority when acting for someone else. Form: https://www.tpos.co.uk/images/documents/forms/TPOE47-Complaints-Form.pdf (leasehold or managing agent: https://www.tpos.co.uk/images/documents/forms/TPOE74-RLM_Complaints_Form.pdf). Fill it in and add it to the complaint''s Documents first, so it goes with the referral.',
  evidence = evidence || '{"refer_email": {"url": "https://www.tpos.co.uk/images/documents/forms/TPOE47-Complaints-Form.pdf", "text": "You can send your form to TPO electronically to admin@tpos.co.uk ... you will need to ensure that the document is signed and you have attached any relevant supporting documentation."}}'::jsonb,
  updated_at = now()
WHERE key = 'tpo' AND refer_email IS NULL;

UPDATE ombudsmen SET
  refer_email = 'complaint.info@financial-ombudsman.org.uk',
  refer_email_note = 'Send their complaint form, filled in and signed, with the final response letter: https://www.financial-ombudsman.org.uk/files/324178/Financial-Ombudsman-Service-complaint-form-v2.pdf (a small business: https://files.financial-ombudsman.org.uk/public/Complaint-forms/6fe816a698/Complaint-form-SME.pdf). A professional representative also needs the customer''s signed declaration form. Add them to the complaint''s Documents first, so they go with the referral. Their online form is quicker.',
  evidence = evidence || '{"refer_email": {"url": "https://www.financial-ombudsman.org.uk/contact-us", "text": "Email: complaint.info@financial-ombudsman.org.uk"}, "complaint_form": {"url": "https://www.financial-ombudsman.org.uk/files/324178/Financial-Ombudsman-Service-complaint-form-v2.pdf", "text": "Financial Ombudsman Service complaint form"}}'::jsonb,
  updated_at = now()
WHERE key = 'fos' AND refer_email IS NULL;

UPDATE ombudsmen SET
  refer_email_note = 'Not by email: since 13 January 2026 new complaints are taken only by their online form or by phone. Email (casework@housing-ombudsman.org.uk) is for a case that already exists, e.g. sending the signed consent form quoting the case reference.',
  updated_at = now()
WHERE key = 'housing_ombudsman' AND refer_email_note IS NULL;

UPDATE ombudsmen SET
  refer_email_note = 'Not by email: new complaints by their online form, by phone, or on their postal complaint form (https://www.lgo.org.uk/complain-to-us-by-post) sent to PO Box 4771, Coventry CV4 0EH.',
  evidence = evidence || '{"refer_post": {"url": "https://www.lgo.org.uk/complain-to-us-by-post", "text": "download the postal complaint form and send it to PO Box 4771, Coventry CV4 0EH"}}'::jsonb,
  updated_at = now()
WHERE key = 'lgsco' AND refer_email_note IS NULL;

UPDATE ombudsmen SET
  refer_email_note = 'Not by email: CCW says complaint emails are not actioned. Use their online form or phone.',
  updated_at = now()
WHERE key = 'ccw' AND refer_email_note IS NULL;

UPDATE ombudsmen SET
  refer_email_note = 'Not confirmed: complaints@theprs.co.uk appears to be for cases already open. Use their online platform, or ask them whether a new complaint can be emailed.',
  updated_at = now()
WHERE key = 'prs' AND refer_email_note IS NULL;
