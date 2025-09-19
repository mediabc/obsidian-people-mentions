import { 
    Plugin, 
    MarkdownView, 
    MarkdownPostProcessorContext,
    TFile,
    WorkspaceLeaf,
    ItemView,
    ViewState,
    EditorSuggest,
    EditorPosition,
    Editor,
    TAbstractFile,
    EditorSuggestContext,
    EditorSuggestTriggerInfo,
    Notice,
    IconName,
    EditorTransaction,
    MarkdownFileInfo,
    editorViewField,
    PluginSettingTab,
    Setting
} from 'obsidian';

import * as yaml from 'js-yaml';

import { EditorView, Decoration, DecorationSet, ViewUpdate } from '@codemirror/view';
import { StateField, StateEffect } from '@codemirror/state';

interface MentionsPluginSettings {
    debugMode: boolean;
    autoUpdateProperties: boolean;
    propertiesFieldName: string;
}

const DEFAULT_SETTINGS: MentionsPluginSettings = {
    debugMode: false,
    autoUpdateProperties: true,
    propertiesFieldName: 'mentions'
};

class DebugLogger {
    private enabled: boolean;

    constructor(enabled: boolean = false) {
        this.enabled = enabled;
    }

    setEnabled(enabled: boolean) {
        this.enabled = enabled;
    }

    log(...args: any[]) {
        if (this.enabled) {
            console.log('[Mentions Debug]:', ...args);
        }
    }
}

class MentionsSettingTab extends PluginSettingTab {
    plugin: MentionsPlugin;

    constructor(plugin: MentionsPlugin) {
        super(plugin.app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Debug Mode')
            .setDesc('Enable debug logging in the console')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.debugMode)
                .onChange(async (value) => {
                    this.plugin.settings.debugMode = value;
                    this.plugin.debugLogger.setEnabled(value);
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Auto-update properties')
            .setDesc('Automatically update mentions in file properties when document changes')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoUpdateProperties)
                .onChange(async (value) => {
                    this.plugin.settings.autoUpdateProperties = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Properties field name')
            .setDesc('Name of the property field to store mentions (default: mentions)')
            .addText(text => text
                .setPlaceholder('mentions')
                .setValue(this.plugin.settings.propertiesFieldName)
                .onChange(async (value) => {
                    this.plugin.settings.propertiesFieldName = value || 'mentions';
                    await this.plugin.saveSettings();
                }));
    }
}

interface Mention {
    text: string;
    file: string;
    position: number;
}

const VIEW_TYPE_MENTIONS = "mentions-view";

class MentionSuggest extends EditorSuggest<string> {
    plugin: MentionsPlugin;

    constructor(plugin: MentionsPlugin) {
        super(plugin.app);
        this.plugin = plugin;
    }

    onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
        const line = editor.getLine(cursor.line);
        const subString = line.substring(0, cursor.ch);
        const match = subString.match(/(?:^|\s)(@[a-zа-я.-]*)$/);

        this.plugin.debugLogger.log('MentionSuggest.onTrigger:', { line, subString, match });

        if (!match) return null;

        return {
            start: {
                line: cursor.line,
                ch: match.index! + match[0].indexOf('@'),
            },
            end: cursor,
            query: match[1].slice(1),
        };
    }

    getSuggestions(context: EditorSuggestContext): string[] {
        const query = context.query.toLowerCase();
        const mentions = this.plugin.getMentions();
        this.plugin.debugLogger.log('Raw mentions from plugin:', mentions);
        
        const uniqueMentions = new Set(mentions.map(m => m.text));
        this.plugin.debugLogger.log('Unique mentions:', Array.from(uniqueMentions));
        
        const suggestions = Array.from(uniqueMentions)
            .filter(mention => mention.toLowerCase().includes(query))
            .sort();

        this.plugin.debugLogger.log('MentionSuggest.getSuggestions:', { 
            query, 
            mentionsCount: mentions.length,
            suggestionsCount: suggestions.length,
            suggestions,
            uniqueMentionsCount: uniqueMentions.size
        });

        return suggestions;
    }

    renderSuggestion(value: string, el: HTMLElement): void {
        el.createEl("div", { text: value });
    }

    selectSuggestion(value: string): void {
        const { context } = this;
        if (context) {
            const editor = context.editor;
            editor.replaceRange(
                value + ' ',
                { line: context.start.line, ch: context.start.ch },
                context.end
            );
            
            const newCursorPos = {
                line: context.end.line,
                ch: context.start.ch + value.length + 1
            };
            editor.setCursor(newCursorPos);
        }
    }
}

class MentionsView extends ItemView {
    mentions: Mention[] = [];
    plugin: MentionsPlugin;
    private sortBy: 'alphabetical' | 'count' = 'alphabetical';

    constructor(leaf: WorkspaceLeaf, plugin: MentionsPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return VIEW_TYPE_MENTIONS;
    }

    getIcon(): IconName {
        return "at-sign";
    }
    getDisplayText(): string {
        return "People mentions";
    }

    async setMentions(mentions: Mention[]) {
        this.mentions = mentions;
        await this.refresh();
    }

    async refresh() {
        const container = this.containerEl.children[1];
        container.empty();

        // Create header container with title and refresh button
        const headerContainer = container.createEl("div", { cls: "mentions-header" });
        
        // Add title
        headerContainer.createEl("h2", { text: "People mentions", cls: "mentions-title" });
        
        // Add refresh button with text instead of icon
        const refreshButton = headerContainer.createEl("button", { 
            cls: "mentions-refresh-button",
            text: "Обновить",
            attr: { 'aria-label': 'Refresh all mentions' }
        });
        
        refreshButton.addEventListener("click", async () => {
            refreshButton.addClass("refreshing");
            await this.plugin.refreshAllMentions();
            refreshButton.removeClass("refreshing");
        });

        // Add button to update properties for all files
        const updatePropertiesButton = headerContainer.createEl("button", { 
            cls: "mentions-update-properties-button",
            text: "Обновить Properties",
            attr: { 'aria-label': 'Update mentions in all file properties' }
        });
        
        updatePropertiesButton.addEventListener("click", async () => {
            updatePropertiesButton.addClass("refreshing");
            await this.plugin.updateMentionsForAllFiles();
            updatePropertiesButton.removeClass("refreshing");
        });

        // Add sorting controls
        const sortContainer = container.createEl("div", { cls: "mentions-sort-container" });
        
        sortContainer.createEl("span", { 
            text: "Сортировка:", 
            cls: "mentions-sort-label" 
        });
        
        const sortSelect = sortContainer.createEl("select", { cls: "mentions-sort-select" });
        
        const alphabeticalOption = sortSelect.createEl("option", { 
            text: "По алфавиту",
            value: "alphabetical"
        });
        
        const countOption = sortSelect.createEl("option", { 
            text: "По количеству упоминаний",
            value: "count"
        });
        
        sortSelect.value = this.sortBy;
        
        sortSelect.addEventListener("change", async () => {
            this.sortBy = sortSelect.value as 'alphabetical' | 'count';
            await this.refresh();
        });

        // Group mentions by text
        const mentionGroups = new Map<string, Mention[]>();
        this.mentions.forEach(mention => {
            const existingGroup = mentionGroups.get(mention.text) || [];
            mentionGroups.set(mention.text, [...existingGroup, mention]);
        });

        const mentionsList = container.createEl("ul", { cls: "mentions-list" });

        // Sort mentions based on selected option
        let sortedMentions: [string, Mention[]][];
        
        if (this.sortBy === 'alphabetical') {
            sortedMentions = Array.from(mentionGroups.entries()).sort(([a], [b]) => a.localeCompare(b));
        } else { // sort by count
            sortedMentions = Array.from(mentionGroups.entries()).sort(([, mentionsA], [, mentionsB]) => {
                const uniqueFilesA = new Set(mentionsA.map(m => m.file)).size;
                const uniqueFilesB = new Set(mentionsB.map(m => m.file)).size;
                return uniqueFilesB - uniqueFilesA; // Descending order (most mentions first)
            });
        }

        sortedMentions.forEach(([mentionText, mentions]) => {
            const uniqueFiles = new Set(mentions.map(m => m.file));
            const fileCount = uniqueFiles.size;

            const item = mentionsList.createEl("li", { cls: "mentions-list-item" });
            item.createEl("strong", { text: mentionText });
            item.createEl("br");
            item.createEl("span", { 
                text: `Found in ${fileCount} file${fileCount !== 1 ? 's' : ''}`,
                cls: "mention-file-count" 
            });

            item.addEventListener("click", () => {
                // Open search panel with the mention text
                const searchLeaf = this.app.workspace.getLeavesOfType('search')[0] || 
                    this.app.workspace.getRightLeaf(false);
                    
                searchLeaf.setViewState({
                    type: 'search',
                    state: { query: mentionText }
                });
                
                this.app.workspace.revealLeaf(searchLeaf);
            });
        });
    }
}

export default class MentionsPlugin extends Plugin {
    private mentionsView: MentionsView;
    private mentions: Mention[] = [];
    private mentionSuggest: MentionSuggest;
    private editorDecorations: Map<string, DecorationSet> = new Map();
    settings: MentionsPluginSettings;
    debugLogger: DebugLogger;
    private updatingProperties: Set<string> = new Set(); // Track files being updated to prevent loops

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        this.debugLogger = new DebugLogger(this.settings.debugMode);
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    getMentions(): Mention[] {
        this.debugLogger.log('Getting mentions:', this.mentions);
        return this.mentions;
    }

    /**
     * Extract mentions from file content
     */
    extractMentionsFromContent(content: string): string[] {
        const matches = content.match(/(?:^|\s)(@[a-zа-я.-]+)(?=\s|$|[^\w.-])/g);
        if (!matches) return [];
        
        const mentions = matches.map(match => {
            const cleanMatch = match.replace(/^\s*/, ''); // Remove leading whitespace
            const mention = cleanMatch.substring(1); // Remove @ symbol
            // Remove trailing punctuation
            return mention.replace(/[.,!?;:]+$/, '');
        });
        return [...new Set(mentions)]; // Remove duplicates
    }

    /**
     * Update file properties with mentions
     */
    async updateFileProperties(file: TFile, mentions: string[]): Promise<void> {
        try {
            // Prevent infinite loops
            if (this.updatingProperties.has(file.path)) {
                this.debugLogger.log('Skipping property update for', file.path, '- already updating');
                return;
            }
            
            this.updatingProperties.add(file.path);
            this.debugLogger.log('Updating file properties for:', file.path, 'with mentions:', mentions);
            
            // Read current file content
            const content = await this.app.vault.read(file);
            
            // Parse frontmatter
            const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
            const frontmatterMatch = content.match(frontmatterRegex);
            
            let frontmatter: any = {};
            let bodyContent = content;
            
            if (frontmatterMatch) {
                const frontmatterString = frontmatterMatch[1];
                bodyContent = content.replace(frontmatterRegex, '');
                
                // Parse YAML frontmatter using js-yaml
                try {
                    frontmatter = yaml.load(frontmatterString) || {};
                    // Ensure frontmatter is an object
                    if (typeof frontmatter !== 'object' || frontmatter === null) {
                        frontmatter = {};
                    }
                } catch (error) {
                    this.debugLogger.log('Error parsing YAML frontmatter, using empty object:', error);
                    frontmatter = {};
                }
            }
            
            // Update mentions in frontmatter (only this field)
            frontmatter[this.settings.propertiesFieldName] = mentions;
            
            // Convert back to YAML and build new content
            let newFrontmatter = '';
            try {
                if (Object.keys(frontmatter).length > 0) {
                    const yamlString = yaml.dump(frontmatter, {
                        flowLevel: -1,
                        quotingType: '"'
                    });
                    newFrontmatter = `---\n${yamlString}---\n`;
                }
            } catch (error) {
                this.debugLogger.log('Error converting to YAML:', error);
                // Fallback to simple format
                const newFrontmatterLines = Object.entries(frontmatter).map(([key, value]) => {
                    if (Array.isArray(value)) {
                        if (value.length === 0) {
                            return `${key}: []`;
                        }
                        return `${key}: [${value.map(v => `"${v}"`).join(', ')}]`;
                    } else {
                        return `${key}: "${value}"`;
                    }
                });
                newFrontmatter = newFrontmatterLines.length > 0 
                    ? `---\n${newFrontmatterLines.join('\n')}\n---\n` 
                    : '';
            }
            
            const newContent = newFrontmatter + bodyContent;
            
            // Write updated content
            await this.app.vault.modify(file, newContent);
            
            this.debugLogger.log('File properties updated successfully for:', file.path);
        } catch (error) {
            console.error('Error updating file properties:', error);
            new Notice(`Error updating properties for ${file.name}: ${error.message}`);
        } finally {
            // Always remove the file from updating set
            this.updatingProperties.delete(file.path);
        }
    }

    /**
     * Update properties for a specific file
     */
    async updateMentionsForFile(file: TFile): Promise<void> {
        try {
            const content = await this.app.vault.read(file);
            const mentions = this.extractMentionsFromContent(content);
            await this.updateFileProperties(file, mentions);
            
            new Notice(`Updated mentions for ${file.name}`);
        } catch (error) {
            console.error('Error updating mentions for file:', error);
            new Notice(`Error updating mentions for ${file.name}`);
        }
    }

    /**
     * Update properties for all markdown files
     */
    async updateMentionsForAllFiles(): Promise<void> {
        try {
            const files = this.app.vault.getMarkdownFiles();
            let updatedCount = 0;
            
            for (const file of files) {
                const content = await this.app.vault.read(file);
                const mentions = this.extractMentionsFromContent(content);
                
                if (mentions.length > 0) {
                    await this.updateFileProperties(file, mentions);
                    updatedCount++;
                }
            }
            
            new Notice(`Updated mentions for ${updatedCount} files`);
        } catch (error) {
            console.error('Error updating mentions for all files:', error);
            new Notice('Error updating mentions for all files');
        }
    }

    async refreshAllMentions(): Promise<void> {
        this.debugLogger.log('Starting full mentions refresh...');
        
        // Clear existing mentions
        this.mentions = [];
        
        // Process all markdown files
        const files = this.app.vault.getMarkdownFiles();
        for (const file of files) {
            const content = await this.app.vault.read(file);
            const matches = content.match(/(?:^|\s)(@[a-zа-я.-]+)/g);
            if (matches) {
                matches.forEach(match => {
                    const cleanMatch = match.replace(/^\s*/, '');
                    const position = content.indexOf(match);
                    // Only add if not already exists
                    const exists = this.mentions.some(m => 
                        m.text === cleanMatch && 
                        m.file === file.path && 
                        m.position === position
                    );
                    if (!exists) {
                        this.mentions.push({
                            text: cleanMatch,
                            file: file.path,
                            position
                        });
                    }
                });
            }
        }

        this.debugLogger.log('Mentions refresh completed:', this.mentions);
        
        // Update view and save data
        if (this.mentionsView) {
            await this.mentionsView.setMentions(this.mentions);
        }
        await this.saveData(this.mentions);
        
        new Notice('Mentions refreshed successfully');
    }

    searchMentions(mentionText: string): Mention[] {
        // Remove @ symbol if present
        const searchText = mentionText.startsWith('@') ? mentionText : '@' + mentionText;
        console.log('Searching for mentions:', {
            searchText,
            currentMentions: this.mentions,
            matchingMentions: this.mentions.filter(mention => {
                // Ensure the mention starts with whitespace or is at the beginning of a line
                const cleanMention = mention.text.trim();
                return cleanMention === searchText;
            })
        });
        return this.mentions.filter(mention => {
            const cleanMention = mention.text.trim();
            return cleanMention === searchText;
        });
    }

    async showMentionResults(mentionText: string) {
        console.log('Showing mention results for:', mentionText);
        const results = this.searchMentions(mentionText);
        console.log('Search results:', results);
        
        if (results.length > 0) {
            // Update the mentions view with search results
            if (this.mentionsView) {
                await this.mentionsView.setMentions(results);
                await this.activateMentionsView();
            }
            new Notice(`Found ${results.length} mentions of ${mentionText}`);
        } else {
            new Notice(`No mentions found for ${mentionText}`);
        }
    }

    async activateMentionsView() {
        const { workspace } = this.app;
        
        let leaf = workspace.getLeavesOfType(VIEW_TYPE_MENTIONS)[0];
        
        if (!leaf) {
            const rightLeaf = workspace.getRightLeaf(false);
            if (rightLeaf) {
                leaf = rightLeaf;
                await leaf.setViewState({
                    type: VIEW_TYPE_MENTIONS,
                    active: true,
                    history: false
                } as ViewState);
            }
        }

        if (leaf) {
            workspace.revealLeaf(leaf);
            if (this.mentionsView) {
                await this.mentionsView.setMentions(this.mentions);
            }
        }
    }

    async onload() {
        await this.loadSettings();
        
        this.addSettingTab(new MentionsSettingTab(this));
        
        console.log('MentionsPlugin loading...');

        // Add CSS
        const mentionStyles = document.createElement('style');
        mentionStyles.textContent = `
            .mention-tag {
                color: var(--text-accent);
                background-color: var(--background-modifier-border);
                padding: 0 4px;
                border-radius: 4px;
                cursor: pointer;
                display: inline-block;
                transition: background-color 0.2s ease;
                white-space: nowrap;
                line-height: normal;
            }
            .mention-tag:hover {
                background-color: var(--background-modifier-border-hover);
            }
            .mentions-list-item {
                padding: 8px;
                margin: 4px 0;
                border-radius: 4px;
                cursor: pointer;
                transition: background-color 0.2s ease;
            }
            .mentions-list-item:hover {
                background-color: var(--background-modifier-border);
            }
            .mention-file-count {
                color: var(--text-muted);
                font-size: 0.9em;
            }
            .mentions-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 16px;
                flex-wrap: wrap;
                gap: 8px;
            }
            .mentions-title {
                margin: 0;
                flex: 1;
            }
            .mentions-refresh-button,
            .mentions-update-properties-button {
                padding: 4px 8px;
                font-size: 0.8em;
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                background: var(--background-primary);
                color: var(--text-normal);
                cursor: pointer;
                transition: all 0.2s ease;
            }
            .mentions-refresh-button:hover,
            .mentions-update-properties-button:hover {
                background: var(--background-modifier-border);
            }
            .mentions-refresh-button.refreshing,
            .mentions-update-properties-button.refreshing {
                opacity: 0.6;
                cursor: not-allowed;
            }
            .mentions-sort-container {
                display: flex;
                align-items: center;
                gap: 8px;
                margin-bottom: 16px;
                padding: 8px;
                background: var(--background-secondary);
                border-radius: 4px;
            }
            .mentions-sort-label {
                color: var(--text-normal);
                font-size: 0.9em;
                font-weight: 500;
            }
            .mentions-sort-select {
                padding: 4px 8px;
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                background: var(--background-primary);
                color: var(--text-normal);
                cursor: pointer;
                font-size: 0.9em;
            }
            .mentions-sort-select:hover {
                border-color: var(--background-modifier-border-hover);
            }
            .mentions-sort-select:focus {
                outline: none;
                border-color: var(--interactive-accent);
            }
        `;
        document.head.appendChild(mentionStyles);

        // Initialize views and UI first
        this.registerView(
            VIEW_TYPE_MENTIONS,
            (leaf) => (this.mentionsView = new MentionsView(leaf, this))
        );

        this.mentionSuggest = new MentionSuggest(this);
        this.registerEditorSuggest(this.mentionSuggest);

        // Register editor extension for live highlighting
        this.registerEditorExtension([
            this.decorateMentions()
        ]);

        this.addRibbonIcon("at-sign", "Show People mentions", () => {
            this.activateMentionsView();
        });

        this.addCommand({
            id: "show-mentions-view",
            name: "Show People mentions View",
            callback: () => {
                this.activateMentionsView();
            }
        });

        this.addCommand({
            id: "update-current-file-mentions",
            name: "Update mentions in current file properties",
            editorCallback: (editor: Editor, view: MarkdownView) => {
                if (view.file) {
                    this.updateMentionsForFile(view.file);
                }
            }
        });

        this.addCommand({
            id: "update-all-files-mentions",
            name: "Update mentions in all files properties",
            callback: () => {
                this.updateMentionsForAllFiles();
            }
        });

        // Then handle mentions data
        try {
            // Load saved mentions
            const savedMentions = await this.loadData();
            console.log('Loading mentions from storage:', {
                savedMentions,
                hasData: !!savedMentions,
                dataType: typeof savedMentions
            });
            
            if (savedMentions) {
                this.mentions = savedMentions;
                console.log('Mentions loaded into memory:', this.mentions);
            }

            // Process all existing markdown files
            console.log('Processing existing files for mentions...');
            const files = this.app.vault.getMarkdownFiles();
            for (const file of files) {
                const content = await this.app.vault.read(file);
                const matches = content.match(/(?:^|\s)(@[a-zа-я.-]+)/g);
                if (matches) {
                    console.log(`Found mentions in ${file.path}:`, matches);
                    matches.forEach(match => {
                        const cleanMatch = match.replace(/^\s*/, '');
                        const position = content.indexOf(match);
                        // Only add if not already exists
                        const exists = this.mentions.some(m => 
                            m.text === cleanMatch && 
                            m.file === file.path && 
                            m.position === position
                        );
                        if (!exists) {
                            this.mentions.push({
                                text: cleanMatch,
                                file: file.path,
                                position
                            });
                        }
                    });
                }
            }

            if (this.mentions.length > 0) {
                console.log('Initial mentions found:', this.mentions);
                if (this.mentionsView) {
                    await this.mentionsView.setMentions(this.mentions);
                }
                await this.saveData(this.mentions);
            }

            // Register the markdown processor
            const processor = async (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
                console.log('MarkdownPostProcessor called for:', ctx.sourcePath);
                console.log('Element content:', el.innerHTML);
                console.log('Current mentions in memory:', this.mentions);

                // First, find all existing mention elements and remove them
                el.querySelectorAll('.mention-tag').forEach(el => el.remove());

                const codeBlocks = el.querySelectorAll('code');
                console.log('Found code blocks:', codeBlocks.length);
                
                // Skip processing code blocks
                codeBlocks.forEach(block => {
                    block.addClass('mentions-ignore');
                });

                // Process text nodes for mentions
                const walker = document.createTreeWalker(
                    el,
                    NodeFilter.SHOW_TEXT,
                    {
                        acceptNode: function(node) {
                            const isInCodeBlock = node.parentElement?.closest('.mentions-ignore');
                            const isInMention = node.parentElement?.hasClass('mention-tag');
                            console.log('Checking node:', {
                                text: node.textContent,
                                isInCodeBlock,
                                isInMention,
                                parentElement: node.parentElement?.tagName,
                                classList: node.parentElement?.className
                            });
                            // Skip nodes that are children of code blocks or existing mentions
                            if (isInCodeBlock || isInMention) {
                                return NodeFilter.FILTER_REJECT;
                            }
                            return NodeFilter.FILTER_ACCEPT;
                        }
                    }
                );

                const nodesToProcess: {node: Text, matches: RegExpMatchArray}[] = [];
                let node: Text | null;
                let nodeCount = 0;
                
                while (node = walker.nextNode() as Text) {
                    nodeCount++;
                    const matchResult = node.textContent?.match(/(?:^|\s)(@[a-zа-я.-]+)/g);
                    console.log(`Processing node ${nodeCount}:`, {
                        text: node.textContent,
                        matchResult
                    });
                    if (matchResult && matchResult.length > 0) {
                        nodesToProcess.push({node, matches: matchResult});
                    }
                }

                console.log(`Found ${nodesToProcess.length} nodes with mentions`);

                nodesToProcess.forEach(({node, matches}) => {
                    let pos = 0;
                    let text = node.textContent || '';
                    const fragment = document.createDocumentFragment();

                    matches.forEach((match: string) => {
                        // Add text before the mention
                        const cleanMatch = match.replace(/^\s*/, '');
                        const beforeText = text.slice(pos, text.indexOf(match, pos));
                        if (beforeText) {
                            fragment.append(beforeText);
                        }

                        // Create the mention element
                        const mentionEl = document.createElement('span');
                        mentionEl.addClass('mention');
                        mentionEl.addClass('mention-tag');
                        mentionEl.textContent = cleanMatch;
                        mentionEl.style.cursor = 'pointer';
                        mentionEl.setAttribute('data-mention', cleanMatch);
                        
                        // Store the mention before adding the click handler
                        const position = text.indexOf(match, pos);
                        const mention = {
                            text: cleanMatch,
                            file: ctx.sourcePath,
                            position: position
                        };
                        
                        // Only add if not already exists
                        const exists = this.mentions.some(m => 
                            m.text === cleanMatch && 
                            m.file === ctx.sourcePath && 
                            m.position === position
                        );
                        
                        if (!exists) {
                            console.log('Adding new mention:', mention);
                            this.mentions.push(mention);
                            this.saveData(this.mentions);
                        }

                        const clickHandler = async (e: MouseEvent) => {
                            console.log('Click handler called');
                            e.preventDefault();
                            e.stopPropagation();
                            console.log('Mention clicked:', {
                                match: cleanMatch,
                                fullText: cleanMatch,
                                searchText: cleanMatch.slice(1)
                            });
                            await this.showMentionResults(cleanMatch.slice(1)); // Remove @ symbol
                        };

                        mentionEl.removeEventListener('click', clickHandler);
                        mentionEl.addEventListener('click', clickHandler);
                        
                        fragment.append(mentionEl);
                        pos = text.indexOf(match, pos) + match.length;
                    });

                    // Add any remaining text
                    if (pos < text.length) {
                        fragment.append(text.slice(pos));
                    }

                    node.replaceWith(fragment);
                });

                // Update the view and save data if mentions were found
                if (nodesToProcess.length > 0) {
                    console.log('Found new mentions, current state:', {
                        newMentions: nodesToProcess.length,
                        totalMentions: this.mentions.length,
                        mentionsData: this.mentions
                    });
                    
                    if (this.mentionsView) {
                        this.mentionsView.setMentions(this.mentions);
                    }
                    
                    console.log('Saving mentions to storage...');
                    await this.saveData(this.mentions);
                    console.log('Mentions saved successfully');
                }
            };

            // Register for both normal preview and live preview
            this.registerMarkdownPostProcessor(processor);

            // Register events for file modifications
            this.registerEvent(
                this.app.vault.on("modify", async (file) => {
                    if (file instanceof TFile && file.extension === 'md') {
                        // Skip if we're currently updating properties for this file
                        if (this.updatingProperties.has(file.path)) {
                            this.debugLogger.log('Skipping modify event for', file.path, '- currently updating properties');
                            return;
                        }
                        
                        console.log('File modified:', file.path);
                        
                        // Get file content
                        const content = await this.app.vault.read(file);
                        console.log('Processing file content for mentions');
                        
                        // Remove old mentions for this file
                        this.mentions = this.mentions.filter(m => m.file !== file.path);
                        
                        // Find all mentions in the file
                        const matches = content.match(/(?:^|\s)(@[a-zа-я.-]+)/g);
                        if (matches) {
                            console.log('Found mentions in file:', matches);
                            
                            // Add new mentions
                            matches.forEach(match => {
                                const cleanMatch = match.replace(/^\s*/, '');
                                const position = content.indexOf(match);
                                this.mentions.push({
                                    text: cleanMatch,
                                    file: file.path,
                                    position
                                });
                            });
                        }
                        
                        console.log('Updated mentions:', this.mentions);
                        
                        // Update view and save
                        if (this.mentionsView) {
                            await this.mentionsView.setMentions(this.mentions);
                        }
                        await this.saveData(this.mentions);

                        // Auto-update properties if enabled
                        if (this.settings.autoUpdateProperties) {
                            const fileMentions = this.extractMentionsFromContent(content);
                            if (fileMentions.length > 0) {
                                await this.updateFileProperties(file, fileMentions);
                            }
                        }
                    }
                })
            );

            // Register for file deletion
            this.registerEvent(
                this.app.vault.on("delete", async (file) => {
                    if (file instanceof TFile && file.extension === 'md') {
                        console.log('File deleted:', file.path);
                        
                        // Remove all mentions from the deleted file
                        const beforeCount = this.mentions.length;
                        this.mentions = this.mentions.filter(m => m.file !== file.path);
                        const removedCount = beforeCount - this.mentions.length;
                        
                        if (removedCount > 0) {
                            console.log(`Removed ${removedCount} mentions from deleted file:`, file.path);
                            
                            // Update view and save
                            if (this.mentionsView) {
                                await this.mentionsView.setMentions(this.mentions);
                            }
                            await this.saveData(this.mentions);
                        }
                    }
                })
            );

            // Also register for file creation
            this.registerEvent(
                this.app.vault.on("create", async (file) => {
                    if (file instanceof TFile && file.extension === 'md') {
                        console.log('New file created:', file.path);
                        const content = await this.app.vault.read(file);
                        const matches = content.match(/(?:^|\s)(@[a-zа-я.-]+)/g);
                        if (matches) {
                            matches.forEach(match => {
                                const cleanMatch = match.replace(/^\s*/, '');
                                const position = content.indexOf(match);
                                this.mentions.push({
                                    text: cleanMatch,
                                    file: file.path,
                                    position
                                });
                            });
                            
                            // Update view and save
                            if (this.mentionsView) {
                                await this.mentionsView.setMentions(this.mentions);
                            }
                            await this.saveData(this.mentions);

                            // Auto-update properties if enabled
                            if (this.settings.autoUpdateProperties) {
                                const fileMentions = this.extractMentionsFromContent(content);
                                if (fileMentions.length > 0) {
                                    await this.updateFileProperties(file, fileMentions);
                                }
                            }
                        }
                    }
                })
            );

            // Register for file rename
            this.registerEvent(
                this.app.vault.on("rename", async (file, oldPath) => {
                    if (file instanceof TFile && file.extension === 'md') {
                        console.log('File renamed:', { oldPath, newPath: file.path });
                        
                        // Update file paths in mentions
                        this.mentions = this.mentions.map(mention => 
                            mention.file === oldPath 
                                ? { ...mention, file: file.path }
                                : mention
                        );
                        
                        // Update view and save
                        if (this.mentionsView) {
                            await this.mentionsView.setMentions(this.mentions);
                        }
                        await this.saveData(this.mentions);
                    }
                })
            );

            // Add click handler for mentions
            this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
                const target = evt.target as HTMLElement;
                if (target.hasClass('mention-tag')) {
                    const mentionText = target.textContent;
                    if (mentionText) {
                        evt.preventDefault();
                        evt.stopPropagation();
                        
                        // Open search panel with the mention text
                        const searchLeaf = this.app.workspace.getLeavesOfType('search')[0] || 
                            this.app.workspace.getRightLeaf(false);
                            
                        searchLeaf.setViewState({
                            type: 'search',
                            state: { query: mentionText }
                        });
                        
                        this.app.workspace.revealLeaf(searchLeaf);
                    }
                }
            });

            console.log('MentionsPlugin loaded successfully');
        } catch (error) {
            console.error('Error during MentionsPlugin initialization:', error);
            new Notice('Error initializing Mentions plugin');
        }
    }

    onunload() {
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_MENTIONS);
    }

    private decorateMentions() {
        return StateField.define<DecorationSet>({
            create: () => Decoration.none,
            update: (decorations, tr) => {
                const text = tr.state.doc.toString();
                const matches = text.match(/(?:^|\s)(@[a-zа-я.-]+)/g);
                const decorationArray: any[] = [];

                if (matches) {
                    let pos = 0;
                    matches.forEach((match: string) => {
                        const fullMatch = match;
                        const cleanMatch = match.replace(/^\s*/, '');
                        const start = text.indexOf(fullMatch, pos) + (fullMatch.length - cleanMatch.length);
                        if (start >= 0) {
                            const end = start + cleanMatch.length;
                            const mentionMark = Decoration.mark({
                                class: "mention mention-tag",
                                attributes: { "data-mention": cleanMatch }
                            });
                            decorationArray.push(mentionMark.range(start, end));
                            pos = end;
                        }
                    });
                }

                return Decoration.set(decorationArray, true);
            },
            provide: (field) => EditorView.decorations.from(field)
        });
    }
} 