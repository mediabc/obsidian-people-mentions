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

import { EditorView, Decoration, DecorationSet, ViewUpdate } from '@codemirror/view';
import { StateField, StateEffect } from '@codemirror/state';

interface MentionsPluginSettings {
    debugMode: boolean;
}

const DEFAULT_SETTINGS: MentionsPluginSettings = {
    debugMode: false
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

        // Group mentions by text
        const mentionGroups = new Map<string, Mention[]>();
        this.mentions.forEach(mention => {
            const existingGroup = mentionGroups.get(mention.text) || [];
            mentionGroups.set(mention.text, [...existingGroup, mention]);
        });

        const mentionsList = container.createEl("ul", { cls: "mentions-list" });

        // Sort mentions alphabetically
        const sortedMentions = Array.from(mentionGroups.entries()).sort(([a], [b]) => a.localeCompare(b));

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