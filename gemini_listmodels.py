import json
import sys
from pathlib import Path
from google import genai
import os

CONFIG_PATH = Path(__file__).with_name("config.json")

def load_config():
    with CONFIG_PATH.open(encoding="utf-8") as config_file:
        return json.load(config_file)

config = load_config()
api_key = config.get("apiKey")

client = genai.Client(api_key=api_key)

# List all available models
print("Available Models:")
for model in client.models.list():
    print(f"- {model.name}")