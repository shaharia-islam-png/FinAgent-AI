# 🤖 FinAgent AI — Personal Finance Assistant

An intelligent AI-powered personal finance dashboard built for the **2026 Shenzhen International FinTech Competition**.

Developed by **Aktai Team** (Department of CSE, BAIUST).

---

## 🌟 What Does It Do?

- **Easy Expense Logging:** Type naturally like *"Spent ¥18 on coffee at Starbucks"* and the AI understands it instantly.
- **Smart Parsing:** Uses **Google Gemini AI** to automatically separate the amount, category, and store name.
- **Automated Workflow:** Uses **n8n** to process everything behind the scenes without manual entry.
- **Google Sheets Sync:** Automatically saves every transaction into a Google Sheet ledger.
- **Email Alerts:** Sends email updates using the **Gmail API** when expenses are logged or budget limits are reached.
- **Clean Dark Dashboard:** Designed with HTML, Tailwind CSS, JavaScript, and Chart.js for real-time spend charts and budget tracking.

---

## 🛠️ Tech Stack

- **Frontend:** HTML5, Tailwind CSS, JavaScript
- **Automation / Backend:** n8n Workflow Automation
- **AI Engine:** Google Gemini API
- **Database:** Google Sheets API
- **Notifications:** Gmail API

---

## 🚀 How It Works

1. User enters an expense in the chat box.
2. JavaScript sends the text to an **n8n Webhook**.
3. **Gemini AI** converts the text into a structured JSON format (e.g., Category: Food, Amount: 18).
4. **n8n** adds a new row to **Google Sheets** and calculates remaining budget.
5. The dashboard updates live, and an email notification is sent if needed.

---

## 💻 Live Demo
 - https://finagent-ai-ten.vercel.app/


   
