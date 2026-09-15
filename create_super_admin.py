"""
Creates the first (or an additional) Super Admin account for the platform.

Super Admin accounts are deliberately NOT creatable through any public web
page — they can see and moderate every school on this deployment, so the
only way to create one is by running this script directly on the server,
where only someone with server access can do it.

Usage (run from the school-results/ directory):
    python3 create_super_admin.py
"""
import getpass
import sys

from db import get_db, init_db
from werkzeug.security import generate_password_hash

SECURITY_QUESTIONS = [
    "What was the name of your first school?",
    "What is your mother's maiden name?",
    "What is the name of your favorite teacher?",
    "What was the name of your first pet?",
    "What town were you born in?",
]


def main():
    init_db()  # make sure the database and platform_admins table exist
    conn = get_db()

    print("=== Create a Super Admin account ===\n")
    name = input("Full name: ").strip()
    username = input("Username: ").strip()
    if not name or not username:
        print("Name and username are required.")
        sys.exit(1)

    existing = conn.execute("SELECT id FROM platform_admins WHERE username=?", (username,)).fetchone()
    if existing:
        print(f"A Super Admin with username '{username}' already exists.")
        sys.exit(1)

    password = getpass.getpass("Password (min 6 characters): ")
    confirm = getpass.getpass("Confirm password: ")
    if len(password) < 6:
        print("Password must be at least 6 characters.")
        sys.exit(1)
    if password != confirm:
        print("Passwords don't match.")
        sys.exit(1)

    print("\nSecurity question (for password recovery):")
    for i, q in enumerate(SECURITY_QUESTIONS, start=1):
        print(f"  {i}. {q}")
    choice = input("Choose a number (or press Enter to skip): ").strip()
    question, answer_hash = None, None
    if choice.isdigit() and 1 <= int(choice) <= len(SECURITY_QUESTIONS):
        question = SECURITY_QUESTIONS[int(choice) - 1]
        answer = getpass.getpass("Your answer: ").strip()
        answer_hash = generate_password_hash(answer.lower())

    conn.execute(
        "INSERT INTO platform_admins (name, username, password_hash, security_question, security_answer_hash) "
        "VALUES (?,?,?,?,?)",
        (name, username, generate_password_hash(password), question, answer_hash),
    )
    conn.commit()
    conn.close()
    print(f"\nSuper Admin '{name}' created. Log in at /platform/login.")


if __name__ == "__main__":
    main()
