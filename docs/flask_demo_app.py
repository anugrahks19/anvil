from flask import Flask

app = Flask(__name__)
app.config.update(
    SECRET_KEY="demo-secret",
    DATABASE_PASSWORD="demo-password",
    SERVICE_TOKEN="demo-token",
    SERVICE_KEY="demo-key",
    DISPLAY_NAME="Anvil demo",
)
