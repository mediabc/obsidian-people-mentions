# Obsidian People Mentions Plugin

A plugin for Obsidian that adds support for @mentions of people in your notes. Makes it easy to track and find references to specific individuals across your vault.

## Features

- ✨ Automatic detection and highlighting of @mentions in text
- 🔍 Quick search by clicking on a mention
- 📋 Directory of all people mentions with navigation
- 🎨 Stylish formatting of mentions in text
- ⌨️ Keyboard shortcuts support
- 📝 **NEW**: Bases support: automatic properties column creation with all file mentions
   - 🔄 Auto-update properties when document changes
   - ⚙️ Configurable properties field name and auto-update settings

## Installation

### From Repository

1. Create folder `.obsidian/plugins/obsidian-mentions/` in your Obsidian vault
2. Download the latest release and extract files to the created folder
3. Restart Obsidian
4. Enable plugin in settings (Settings -> Community plugins)

### Build from Source

1. Clone the repository
2. Install dependencies: `npm install`
3. Build plugin: `npm run build`
4. Copy `main.js`, `manifest.json` and `styles.css` to `.obsidian/plugins/obsidian-mentions/` in your vault
5. Restart Obsidian
6. Enable plugin in settings

## Usage

### Creating Mentions

Simply add @ symbol before a person's name in your note:

```markdown
Need to discuss this with @anna and @boris
```

### Navigation

- Click any mention to search for all its occurrences
- Use the side panel (@ icon in left panel) to view all people mentions
- Open mentions list via "Show People mentions View" command (Ctrl/Cmd + P)

### Properties Integration

The plugin can automatically add a `mentions` property to your file's frontmatter containing all people mentioned in that document:

```yaml
---
title: "My Note"
mentions: ["anna", "boris", "victor"]
---

Content with @anna, @boris, and @victor mentions...
```

#### Commands

- **Update mentions in current file properties**: Updates properties for the currently active file
- **Update mentions in all files properties**: Batch update properties for all markdown files in vault

#### Settings

- **Auto-update properties**: Automatically update mention properties when files are modified (default: enabled)
- **Properties field name**: Customize the name of the property field (default: "mentions")

### Supported Mention Formats

- Simple mentions: `@username`, `@person`
- Mentions with hyphen: `@first-last`
- Mentions with dot: `@user.name`
- Combined mentions: `@user.name-full`

Mentions cannot contain numbers or special characters other than dot (.) and hyphen (-).

## Development

### Prerequisites

- Node.js
- npm or yarn
- Obsidian (for testing)

### Development Setup

1. Clone repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run in development mode:
   ```bash
   npm run dev
   ```

### Build

```bash
npm run build
```

## License

MIT 