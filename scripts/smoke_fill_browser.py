#!/usr/bin/env python3
"""Offline real-browser smoke: no publication, credentials, or external sites."""
import sys
from playwright.sync_api import sync_playwright


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        try:
            context = browser.new_context(locale="en-US", viewport={"width": 1280, "height": 900})
            page = context.new_page()
            page.set_content('<article id="story">Browser ready</article>')
            page.evaluate("document.querySelector('#story').dataset.rendered = 'yes'")
            assert page.locator('#story').inner_text() == 'Browser ready'
            assert page.locator('#story').get_attribute('data-rendered') == 'yes'
            print(f"Browser startup and JavaScript passed: Python {sys.executable}; Chromium {browser.version}")
        finally:
            browser.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
