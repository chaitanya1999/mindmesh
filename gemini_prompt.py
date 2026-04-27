import json
import sys
from pathlib import Path

from google import genai


DEFAULT_PROMPT = "Explain how AI works"
CONFIG_PATH = Path(__file__).with_name("config.json")


def load_config():
    with CONFIG_PATH.open(encoding="utf-8") as config_file:
        return json.load(config_file)


def main():
    config = load_config()
    api_key = config.get("apiKey")
    if not api_key:
        print("Missing apiKey in config.json.", file=sys.stderr)
        sys.exit(1)

    model = config["model"]
    prompt = " ".join(sys.argv[1:]) or DEFAULT_PROMPT

    client = genai.Client(api_key=api_key)
    response = client.models.generate_content(
        model=model,
        contents=prompt,
    )

    print(response.text)


if __name__ == "__main__":
    main()
