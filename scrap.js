name: Hollex Scraper

on:
  workflow_dispatch:
    inputs:
      packing_date:
        description: 'Packing date to scrape (format: MM/DD/YYYY)'
        required: false
        default: ''
      urls:
        description: 'Comma-separated list of category URLs to scrape'
        required: true
        default: ''

jobs:
  run-scraper:
    runs-on: ubuntu-latest

    steps:
      # 1️⃣ Checkout repository
      - name: Checkout repository
        uses: actions/checkout@v3

      # 2️⃣ Setup Node.js
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'

      # 3️⃣ Install dependencies
      - name: Install dependencies
        run: npm ci

      # 4️⃣ Install Playwright browsers
      - name: Install Playwright browsers
        run: npx playwright install --force

      # 5️⃣ Create Google service account file from secret
      - name: Create Google credentials
        run: |
          echo '${{ secrets.GOOGLE_SERVICE_ACCOUNT_JSON }}' > service-account.json

      # 6️⃣ Run scraper script
      - name: Run scraper script
        env:
          HOLEX_USERNAME: ${{ secrets.HOLEX_USERNAME }}
          HOLEX_PASSWORD: ${{ secrets.HOLEX_PASSWORD }}
          SPREADSHEET_ID: ${{ secrets.SPREADSHEET_ID }}
          SHEET_NAME: ${{ secrets.SHEET_NAME }}
          LOGIN_URL: ${{ secrets.LOGIN_URL }}
          LOG_PATH: scraper.log
          PACKING_DATE: ${{ github.event.inputs.packing_date }}
          URLS: ${{ github.event.inputs.urls }}
          GOOGLE_APPLICATION_CREDENTIALS: service-account.json
        run: node scrap.js

      # 7️⃣ Trigger Apps Script WebApps
      - name: Trigger Apps Script WebApps
        run: |
          curl -L --post301 --post302 -X POST \
            "https://script.google.com/macros/s/AKfycbyuL6Me8hEP1DReBwiUy-juvHQ-DNjXBwFjqUC3yMnRpC83eEDobckL6nhQVcZyc-Ds/exec" \
            -d "key=B7vN20HxKpL9"

          sleep 10

          curl -L --post301 --post302 -X POST \
            "https://script.google.com/macros/s/AKfycbyuL6Me8hEP1DReBwiUy-juvHQ-DNjXBwFjqUC3yMnRpC83eEDobckL6nhQVcZyc-Ds/exec" \
            -d "key=SIJ9de0sadST"
