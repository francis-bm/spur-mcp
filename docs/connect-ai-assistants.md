---
title: Use Spur inside your AI assistant
description: Connect Spur to Claude, ChatGPT, Microsoft Copilot, Gemini, Grok or Perplexity and run real estate lead generation, skip tracing, direct mail, SMS and email outreach from a chat.
slug: /mcp
last_verified: 2026-10-24
---

<!--
SCREENSHOTS TO CAPTURE BEFORE PUBLISHING
Each image below points to /images/mcp/<file>.png. Capture each one with a test Spur account,
crop to the relevant dialog, and blur any personal names, emails or addresses.

  claude-add-custom-connector.png    Claude > Customize > Connectors > + Add > Add custom connector dialog with the Spur URL filled in
  claude-chat-connectors-menu.png    Claude chat "+" menu > Connectors with the Spur toggle on
  chatgpt-add-custom-mcp.png         chatgpt.com/plugins > + > Add custom MCP server dialog with the Spur URL filled in
  chatgpt-at-mention.png             ChatGPT prompt box with "@Spur" selected
  copilot-studio-mcp-wizard.png      Copilot Studio > Tools > Add a tool > New tool > Model Context Protocol wizard, OAuth 2.0 + Dynamic discovery selected
  gemini-custom-apps.png             gemini.google.com > Settings > Connected Apps > Custom apps with the Spur URL filled in
  grok-new-connector.png             grok.com/connectors > New Connector > Custom with the Spur URL filled in
  perplexity-add-mcp.png             Perplexity > Plugins > Add custom > Connector > Add MCP connector (Remote) form
  spur-sign-in.png                   The Spur sign-in page shown during connection (mcp.usespur.com/oauth/authorize)
  widget-property-explorer.png       Property explorer map widget rendered in Claude or ChatGPT
  widget-postcard-preview.png        Postcard preview widget with the Send button and cost
-->

# Use Spur inside your AI assistant

Spur connects to the AI assistant you already use. Once it's connected, you can type something like *"Find absentee-owned single-family homes in Tampa with 40%+ equity, skip trace the owners, and draft a postcard"* and your assistant will do it in your Spur account. You review and approve the results without leaving the chat.

This page explains how the connection works and how to set it up in:

- [Claude](#claude)
- [ChatGPT](#chatgpt)
- [Microsoft Copilot](#microsoft-copilot)
- [Google Gemini](#google-gemini)
- [Grok](#grok)
- [Perplexity](#perplexity)

**Your Spur connector URL**

```
https://mcp.usespur.com/mcp
```

You'll paste this URL into whichever assistant you use. It's the same for every assistant and every Spur account.

---

## What is the Spur MCP connector?

**MCP** (Model Context Protocol) is an open standard that lets AI assistants use outside tools. Think of it as a universal plug. Spur provides the socket, and Claude, ChatGPT, Gemini and the others each have a plug that fits it.

When you connect Spur, your assistant can:

| Area | What you can ask for |
| --- | --- |
| **Find deals** | Search properties by location, type, equity, owner status and more, then see them on a map with property cards. Save the ones you like. |
| **Find owners** | Look up property owners and skip trace them for phone numbers and emails. |
| **Lists** | Create property lists and add properties to them. |
| **Direct mail** | Design postcards (6×4, 6×9, 6×11) and letters, preview them with a real recipient's details, add tracked QR codes, and mail them. |
| **Email and SMS** | Write and design email and text templates, preview them as they'll look in an inbox or on a phone, and send yourself a test email. |
| **Outreach automations** | Build multi-step sequences (email, SMS, direct mail, waits), enroll owners, and turn them on. |
| **Inbox** | Read your SMS conversations with owners. |
| **Saved searches** | Schedule property searches to run weekly, every two weeks or monthly. |
| **Reporting** | Check campaign stats, direct mail analytics, outreach reports and QR code scans. |
| **Billing** | Check your balance, top up your wallet, or change your plan. |

Spur also includes ready-made starting prompts, such as **Deal hunt**, **Motivated seller research**, **Follow up hot leads**, **Postcard campaign**, **Letter campaign**, **Outreach sequence** and **Weekly review**. In assistants that show MCP prompts, you'll find them in the prompt or attachment menu.

### Interactive previews

In **Claude** and **ChatGPT**, Spur shows interactive panels right in the chat:

- **Property explorer**: a map with price pins and property cards, with **Save**, **Details** and **Find owner** buttons.
- **Postcard and letter preview**: the front and back of your mail piece filled in with a real recipient's details, plus the recipient count, cost and a **Send** button.
- **Email and SMS preview**: your email as it appears in an inbox (desktop, mobile and plain text) or your text as a phone message.
- **Billing**: your wallet balance, top-up buttons and plan options.
- **Image upload**: drag in a photo to use on a postcard, letter or email.

![Spur property explorer map shown inside an AI chat](/images/mcp/widget-property-explorer.png)

Other assistants show the same results as text. Everything still works, you just won't see the map or the visual previews.

---

## How it keeps your account safe

**You sign in with your own Spur account.** When you connect, the assistant opens Spur's sign-in page. You sign in with your Spur email and password (and your MFA code, if you've turned it on), or with Google. Your password goes to Spur, never to the AI assistant.

![Spur sign-in page shown while connecting an AI assistant](/images/mcp/spur-sign-in.png)

**The assistant sees only what you can see.** Every request uses your own Spur session, so your team roles, permissions, billing limits and activity logs apply exactly as they do in the Spur app.

**Nothing that costs money or contacts people happens without your approval.** Sending postcards, letters or texts, skip tracing, enrolling owners in automations, turning automations on, and charging your card all require you to approve that exact action first. For mail, Spur:

1. Shows you a preview with the artwork, the recipients, the cost estimate and your wallet balance.
2. Asks you to confirm ("Mail 10 postcards to real people? About $9.90").
3. Sends only what you previewed. If anything changes (a different template, recipient list or return address), or 30 minutes pass, you'll need a new preview.

Drafting a message or building a new automation never sends anything. New automations start switched off.

**Payments happen on Stripe.** When you top up or upgrade from a chat, Spur gives you a Stripe checkout link. Your card details never pass through the chat.

**You can disconnect at any time.** Remove the connector in your assistant's settings, or go to **Spur → Security** and sign out your sessions. Signing out in Spur also disconnects every connected assistant.

---

## Before you start

You'll need:

- A **Spur account**. [Sign up at usespur.com](https://usespur.com) if you don't have one.
- An account with your AI assistant on a plan that allows custom connectors. Requirements vary by assistant and are listed in each section below.
- **A web browser on a computer.** Most assistants only let you add connectors on the web. Once you've connected Spur, you can use it on mobile too.

If you're on a company or team plan (Claude Team or Enterprise, ChatGPT Business or Enterprise, Microsoft 365, Grok Business, Perplexity Enterprise), your administrator may need to add or allow Spur first. Each section below explains what your admin needs to do.

---

## Claude

**Works with:** Claude on the web (claude.ai), Claude Desktop, Cowork, and the Claude mobile apps once the connector is added.
**Plans:** Free, Pro, Max, Team and Enterprise. The Free plan allows one custom connector.
**Interactive previews:** Yes.

### Pro, Max and Free

1. Go to [claude.ai](https://claude.ai) and open **Customize → Connectors**.
2. Click **+ Add**, then **Add custom connector**.
3. For **Name**, enter `Spur`.
4. For **Remote MCP server URL**, paste `https://mcp.usespur.com/mcp` and click **Continue**.
5. Claude detects Spur's sign-in settings automatically. Leave them as they are and click **Continue**, then **Add**.
6. Click **Connect** next to Spur. A Spur sign-in window opens. Sign in, and you'll be sent back to Claude.

![Adding Spur as a custom connector in Claude](/images/mcp/claude-add-custom-connector.png)

### Team and Enterprise

An organization **Owner** (or, on Enterprise, anyone with permission to manage the organization's connectors) adds Spur once for everyone:

1. Go to **Organization settings → Connectors**.
2. Click **Add**, point to **Custom**, then select **Web**.
3. Enter `Spur` as the name and `https://mcp.usespur.com/mcp` as the URL, then click **Continue**.
4. Keep the detected sign-in settings, click **Continue**, then **Add**.

Each team member then goes to **Customize → Connectors**, finds **Spur**, and clicks **Connect** to sign in with their own Spur account.

### Use Spur in a chat

Connectors are switched on per conversation. In a chat, click the **+** button at the bottom left, choose **Connectors**, and turn on **Spur**.

![Turning on the Spur connector in a Claude chat](/images/mcp/claude-chat-connectors-menu.png)

Then ask for what you need, for example:

> Find vacant single-family homes in Cleveland, OH with at least 50% equity and show them on a map.

To change the connector's settings later, remove it and add it again.

---

## ChatGPT

**Works with:** ChatGPT on the web (chatgpt.com). Once Spur is added there, you can use it in the ChatGPT apps as well.
**Plans:** Plus, Pro, Business, Enterprise and Edu. The Free plan doesn't support custom MCP servers.
**Interactive previews:** Yes.

### Add Spur

1. Go to [chatgpt.com/plugins](https://chatgpt.com/plugins).
2. Click the **+** button, then **Add custom MCP server**.
3. Enter `Spur` as the name and a short description, such as *Real estate leads, skip tracing, direct mail and outreach*.
4. Under **Connection**, choose the public endpoint option and paste `https://mcp.usespur.com/mcp`.
5. For authentication, choose **OAuth**.
6. Read the warning about custom servers and select **I understand and want to continue**.
7. Select **Create as a plugin**. ChatGPT lists Spur's tools so you can review them.
8. Install the plugin. A Spur sign-in window opens. Sign in, and you'll be sent back to ChatGPT.

![Adding Spur as a custom MCP server in ChatGPT](/images/mcp/chatgpt-add-custom-mcp.png)

> **Don't see "Add custom MCP server"?** OpenAI has moved this option several times in 2026. Look for a **Developer mode** switch under **Settings → Security and login** or **Settings → Apps & Connectors → Advanced**, turn it on, and then look for a **Create** or **Create MCP App** button. The fields are the same as above.

### Business, Enterprise and Edu workspaces

A workspace owner or admin controls whether members can add custom MCP servers. If you can't find the option, ask your admin to allow developer mode or custom connectors, or to approve Spur for the workspace.

### Use Spur in a chat

Start a new conversation, type **@** in the message box, and select **Spur**.

![Selecting Spur with @ in a ChatGPT conversation](/images/mcp/chatgpt-at-mention.png)

ChatGPT asks you to confirm before Spur takes any action that changes something in your account.

> Show my saved properties in Phoenix, then draft a 6×9 "We buy houses" postcard and preview it with one of the owners.

**ChatGPT deep research:** Spur also supports ChatGPT's search and fetch features, so deep research can draw on your saved Spur properties and owners.

---

## Microsoft Copilot

**Works with:** Microsoft 365 Copilot and Microsoft Teams, through an agent built in **Microsoft Copilot Studio**.
**Plans:** A Microsoft 365 work account with access to Copilot Studio. Your organization's Power Platform data policies also need to allow the connector.
**Interactive previews:** No. Results appear as text.

The free consumer Copilot app (copilot.microsoft.com and the Windows Copilot app) doesn't currently let you add your own MCP servers. To use Spur with Microsoft Copilot, you or your IT team add it to a Copilot Studio agent, then publish that agent to Microsoft 365 Copilot and Teams.

### Step 1: Create an agent (skip if you already have one)

1. Go to [copilotstudio.microsoft.com](https://copilotstudio.microsoft.com).
2. Create a new agent, for example **Spur Assistant**, with instructions such as: *"Help me find real estate deals, research owners and run outreach using the Spur tools. Always show me a preview and ask before sending mail, texts or anything that costs money."*

### Step 2: Add Spur as an MCP tool

1. Open your agent's **Tools** page.
2. Select **Add a tool → New tool → Model Context Protocol**.
3. Fill in:
   - **Server name:** `Spur`
   - **Server description:** `Real estate property search, owner skip tracing, direct mail (postcards and letters), SMS and email outreach, and marketing automations for the user's Spur account.` Copilot uses this description to decide when to call Spur, so be specific.
   - **Server URL:** `https://mcp.usespur.com/mcp`
4. For **Authentication**, choose **OAuth 2.0**, then select **Dynamic discovery**.
5. Select **Create**, then **Next**.
6. In **Add tool**, choose **Create a new connection** and sign in with your Spur account.
7. Select **Add to agent**.

![Copilot Studio MCP wizard with OAuth 2.0 dynamic discovery selected](/images/mcp/copilot-studio-mcp-wizard.png)

### Step 3: Test and publish

1. Test the agent in the **Test** pane, for example: *"Show my Spur property lists."*
2. **Publish** the agent, then open **Channels** and turn on **Teams and Microsoft 365 Copilot**.
3. Each person who uses the agent signs in with their own Spur account the first time it calls Spur.

> **For IT admins:** Copilot Studio reaches MCP servers through Power Platform connectors. If a data policy blocks custom connectors, it also blocks Spur. Spur uses the Streamable HTTP transport, which is the one Copilot Studio supports.

---

## Google Gemini

**Works with:** The Gemini web app (gemini.google.com). After you connect Spur there, you can also use it in the Gemini mobile app.
**Who can use it:** People 18 or older in the US, using a **personal** Google Account, with **Keep Activity** turned on. Work and school accounts aren't supported yet. Custom apps are English only.
**Interactive previews:** Results appear as text.

### Add Spur

1. On a computer, go to [gemini.google.com](https://gemini.google.com).
2. Click **Settings**, then **Connected Apps**. (If you don't see it, click **Personal Intelligence**, then **Connected Apps**.)
3. Under **Custom apps**, paste `https://mcp.usespur.com/mcp` into **Add a custom app link**. If you've already connected a custom app, click **Add a custom app** first.
4. Click **Next**. You don't need to fill in anything under **Advanced features**, because Spur registers itself automatically.
5. Follow the prompts. A Spur sign-in window opens. Sign in, and you'll be sent back to Gemini.

![Adding Spur as a custom app in Gemini](/images/mcp/gemini-custom-apps.png)

### Use Spur in a chat

Type **@** in the prompt box and choose **Spur**. Gemini asks you to confirm before any action that changes something.

> @Spur Give me my weekly review: new leads, campaign results and replies I haven't answered.

### Turn it off or remove it

In **Settings → Connected Apps → Custom apps**, you can switch Spur off (it stays in your list), or open **More details** and choose **Disconnect** or **Remove app**.

> **Using Gemini Enterprise at work?** Your Google Workspace admin can add Spur as a custom MCP server connector in the Gemini Enterprise admin settings, using the same URL. Spur uses the Streamable HTTP transport, which Gemini Enterprise requires.

---

## Grok

**Works with:** Grok on the web (grok.com).
**Plans:** xAI says connectors are available to all Grok users. On Grok Business and Enterprise, a team admin has to set up the connector first.
**Interactive previews:** Results appear as text.

### Add Spur

1. Go to [grok.com/connectors](https://grok.com/connectors).
2. Click **New Connector**, then select **Custom**.
3. Paste `https://mcp.usespur.com/mcp` as the server URL.
4. Complete the sign-in. A Spur sign-in window opens. Sign in, and you'll be sent back to Grok.
5. Grok finds Spur's tools automatically and makes them available in your conversations.

![Adding Spur as a custom connector in Grok](/images/mcp/grok-new-connector.png)

### Grok Business and Enterprise

A team admin adds Spur in the xAI console (**console.x.ai → your team → Grok Business → Connectors**). Once it's set up, team members can connect their own Spur accounts.

### Use Spur in a chat

Ask about your Spur data directly, and mention Spur by name so Grok knows to use it:

> Using Spur, find pre-foreclosure properties in Atlanta and skip trace the top 10 owners.

---

## Perplexity

**Works with:** Perplexity on the web.
**Plans:** Perplexity doesn't publish a list of plans that include custom connectors. If you don't see the option, your plan may not include it, or, on Enterprise, your admin hasn't allowed member connectors.
**Interactive previews:** Results appear as text.

### Add Spur

1. In Perplexity, open **Plugins** in the sidebar. (If you don't see it, go to **Customize → Connectors**.)
2. Choose **Add custom → Connector → Add MCP connector**.
3. Select **Remote**.
4. Fill in:
   - **Name:** `Spur`
   - **MCP Server URL:** `https://mcp.usespur.com/mcp`
   - **Description (optional):** `Real estate leads, skip tracing, direct mail and outreach`
   - **Authentication:** **OAuth 2.0**. Perplexity discovers Spur's sign-in settings automatically, so you don't need a Client ID or secret.
   - **Transport:** **Streamable HTTP**
5. Tick the acknowledgement box and click **Add**.
6. Click the **Spur** card on the Plugins page. A Spur sign-in window opens. Sign in to turn on the connector.

![Adding Spur as a remote MCP connector in Perplexity](/images/mcp/perplexity-add-mcp.png)

To edit or remove the connector later, use the **⋮** menu on its card.

### Perplexity Enterprise

1. An admin turns on member custom connectors under **Enterprise settings → Connectors → Connector permissions** (it's off by default), or adds Spur for the whole organization under **Enterprise settings → Permissions → Connectors permissions → + Custom connector**.
2. Share the connector with your organization from the **Permissions** screen. Members can't use it until it's shared.
3. Choose **per-member sign-in** for OAuth, so each person connects their own Spur account. Don't use a single shared sign-in.

---

## Things to try

Copy any of these into your assistant once Spur is connected.

**Find deals**
- *"Find absentee-owned duplexes in Memphis built before 1980 with at least 40% equity. Show them on a map."*
- *"Save the five cheapest of those to a new list called Memphis Duplexes."*
- *"Set up a search that runs every Monday at 8am Central for new vacant properties in Dallas County."*

**Research owners**
- *"Who owns 1428 Elm St, Tampa FL? Skip trace them."*
- *"Which owners on my Memphis Duplexes list have a phone number on file?"*

**Mail campaigns**
- *"Design a 6×9 'We buy houses for cash' postcard with a QR code that goes to my website. Preview it with a real owner from my list."*
- *"Copy the Just Sold gallery postcard and change the headline to 'Your neighbor just sold. Thinking about it?'"*
- *"Create a one-page letter for expired listings and preview the cost to mail it to my Phoenix list."*

**Email, SMS and automations**
- *"Write a short, friendly first-touch text for absentee owners. Keep it to one SMS segment."*
- *"Build a 3-step follow-up: text on day 1, email on day 3, postcard on day 10. Keep it off until I've reviewed it."*
- *"Show me my unanswered text conversations from this week."*

**Reporting and billing**
- *"How did last month's postcard campaigns do? Include QR scans."*
- *"What's my wallet balance? Add $50."*

---

## Troubleshooting

**The assistant says it can't reach the server, or the URL is invalid.**
Check the URL is exactly `https://mcp.usespur.com/mcp`, including `https://` and `/mcp` at the end, with no spaces.

**The sign-in window didn't open, or closed without connecting.**
Allow pop-ups for your assistant's website and try again. If your Spur account uses MFA, have your authenticator app ready. If you normally sign in to Spur with Google, choose **Continue with Google** on the Spur sign-in page.

**I can't find the option to add a custom connector.**
Your plan may not include custom connectors (see the plan notes in each section), or your company admin may have turned them off. On work accounts, ask your admin to add or allow Spur.

**The assistant isn't using Spur.**
Make sure Spur is switched on for that conversation (Claude: **+ → Connectors**; ChatGPT and Gemini: type **@Spur**). Mentioning "Spur" in your request also helps.

**I got a billing or "insufficient credits" message.**
Ask the assistant to *"show my billing options"*. You can top up your wallet or upgrade your plan right from the chat.

**I was signed out, or Spur stopped working after a while.**
Sessions expire, and signing out in **Spur → Security** disconnects all assistants. Reconnect from your assistant's connector settings.

**I don't see the map or postcard preview.**
Interactive previews currently appear in Claude and ChatGPT. Other assistants show the same information as text.

**I want to disconnect Spur.**
Remove it from your assistant's connector or app settings. To disconnect every assistant at once, go to **Spur → Security** and sign out all sessions.

---

## FAQ

**Is there an extra charge for using Spur from an AI assistant?**
No. Property searches, skip tracing, mail and messages cost the same as in the Spur app and come out of the same plan allowance and wallet. Your AI assistant's own subscription is separate.

**Can the assistant send mail or texts without asking me?**
No. Every action that spends money or contacts people needs your explicit approval, and mail can only be sent from a preview you've seen.

**Does the AI company get my Spur data?**
The assistant only sees the results of the requests made in your conversation, such as the properties it searched or the owner it looked up. Those results are handled under your assistant provider's privacy policy, like anything else in your chat. Spur's connector doesn't store your data. Every request goes directly to your Spur account.

**Can my whole team use it?**
Yes. Each person signs in with their own Spur account, so everyone keeps their own permissions and data access.

**Do I need to install anything?**
No. Spur's connector runs in the cloud. You only paste the URL into your assistant.

**Is Spur listed in the official MCP Registry?**
Yes, as `com.usespur/spur`.

---

*Assistant menus change often. These steps were last checked on October 24, 2026. If something looks different, [contact Spur support](https://usespur.com) and we'll help you get connected.*
