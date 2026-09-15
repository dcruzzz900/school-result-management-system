# Railway deployment

This package is prepared for Railway using Docker + Gunicorn.

## GitHub structure
Upload the CONTENTS of this `school-results` folder to the root of your GitHub repository. The repository root should contain `Dockerfile`, `railway.toml`, `app.py`, `db.py`, `requirements.txt`, `templates/`, and `static/`.

## Railway variables
Set:
- `SECRET_KEY` = a long random secret value
- `FLASK_DEBUG` = `0`

The application uses `/app/instance` for its SQLite database and uploaded school logos. For persistent data, attach a Railway Volume mounted at `/app/instance`.

## Public URL
After deployment succeeds, open the service's Settings -> Networking and generate a public domain.
