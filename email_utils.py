"""Sends result notifications to parents via the school's own SMTP settings.

Free-tier PythonAnywhere accounts restrict outbound network access, including
raw SMTP connections, to a small allowlist of providers. This will work out
of the box on a paid PythonAnywhere plan, on most other hosts, or with any
SMTP-compatible transactional email provider (e.g. SendGrid, Mailgun) that
exposes standard SMTP credentials. See DEPLOY_PYTHONANYWHERE.md for details.
"""
import smtplib
import ssl
from email.message import EmailMessage


def send_email(school, to_email, subject, body_text, attachment_bytes=None, attachment_filename=None):
    """Returns (success: bool, message: str)."""
    if not school or not school["smtp_host"] or not school["smtp_from_email"]:
        return False, "Email hasn't been set up yet. Ask your admin to configure it under Setup → Email Settings."

    msg = EmailMessage()
    msg["Subject"] = subject
    from_name = school["smtp_from_name"] or school["name"] or "School"
    msg["From"] = f"{from_name} <{school['smtp_from_email']}>"
    msg["To"] = to_email
    msg.set_content(body_text)

    if attachment_bytes and attachment_filename:
        msg.add_attachment(
            attachment_bytes, maintype="application", subtype="pdf", filename=attachment_filename
        )

    host = school["smtp_host"]
    port = school["smtp_port"] or 587
    username = school["smtp_username"]
    password = school["smtp_password"]
    use_tls = bool(school["smtp_use_tls"])

    try:
        if port == 465:
            context = ssl.create_default_context()
            with smtplib.SMTP_SSL(host, port, timeout=15, context=context) as server:
                if username and password:
                    server.login(username, password)
                server.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=15) as server:
                if use_tls:
                    server.starttls(context=ssl.create_default_context())
                if username and password:
                    server.login(username, password)
                server.send_message(msg)
        return True, f"Email sent to {to_email}."
    except Exception as e:
        return False, f"Couldn't send email to {to_email}: {e}"
