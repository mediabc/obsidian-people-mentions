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
    private lastMentionInput: string = '';
    private lastCursorPosition: EditorPosition | null = null;

    constructor(plugin: MentionsPlugin) {
        super(plugin.app);
        this.plugin = plugin;
    }

    onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
        const line = editor.getLine(cursor.line);
        const subString = line.substring(0, cursor.ch);
        const match = subString.match(/(?:^|\s)(@[a-zа-я.-]*)$/);

        this.plugin.debugLogger.log('MentionSuggest.onTrigger:', { line, subString, match });

        // Check if we just completed a mention (typed space after a complete mention)
        if (this.lastCursorPosition && file) {
            this.checkForCompletedMention(cursor, editor, file);
        }

        // Store current state for next check
        this.lastCursorPosition = cursor;
        if (match) {
            this.lastMentionInput = match[1];
        }

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

    private async checkForCompletedMention(cursor: EditorPosition, editor: Editor, file: TFile): Promise<void> {
        // Simplified logic: check if we moved away from a mention and there was a previous mention input
        const line = editor.getLine(cursor.line);
        const subString = line.substring(0, cursor.ch);
        const currentMatch = subString.match(/(?:^|\s)(@[a-zа-я.-]*)$/);
        
        // If there's no current mention being typed but we had one before, check for completion
        if (!currentMatch && this.lastMentionInput) {
            this.plugin.debugLogger.log('Potential mention completion detected, last input was:', this.lastMentionInput);
            
            // Schedule property update with delay - let the user finish their thought
                this.plugin.schedulePropertyUpdate(file, 1000);
            
            // Reset tracking
            this.lastMentionInput = '';
        }
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
            
            // Trigger properties update after selecting a suggestion
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (view && view.file) {
                this.plugin.debugLogger.log('Suggestion selected:', '@' + value);
                // Use the new scheduled update method with longer delay
                this.plugin.schedulePropertyUpdate(view.file, 1000);
            }
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

// Enhanced file properties manager for better stability
class FilePropertiesManager {
    private plugin: MentionsPlugin;
    private updatingProperties: Set<string> = new Set();
    private pendingUpdates: Map<string, NodeJS.Timeout> = new Map();
    private updateQueue: Map<string, { mentions: string[], timestamp: number }> = new Map();
    private readonly DEBOUNCE_DELAY = 1500; // Increased delay for stability
    private readonly MAX_RETRIES = 3;
    private readonly RETRY_DELAY = 500;

    constructor(plugin: MentionsPlugin) {
        this.plugin = plugin;
    }

    /**
     * Schedule a property update with improved debouncing and error handling
     */
    scheduleUpdate(file: TFile, mentions: string[], delay: number = this.DEBOUNCE_DELAY): void {
        if (!this.plugin.settings.autoUpdateProperties) return;

        const filePath = file.path;
        const timestamp = Date.now();
        
        // Store the latest update request
        this.updateQueue.set(filePath, { mentions, timestamp });
        
        // Cancel any existing pending update
        const existingTimeout = this.pendingUpdates.get(filePath);
        if (existingTimeout) {
            clearTimeout(existingTimeout);
            this.plugin.debugLogger.log('Cancelled previous property update for:', filePath);
        }
        
        // Schedule new update
        const timeout = setTimeout(async () => {
            const queuedUpdate = this.updateQueue.get(filePath);
            if (queuedUpdate && queuedUpdate.timestamp === timestamp) {
                await this.executeUpdate(file, queuedUpdate.mentions);
                this.updateQueue.delete(filePath);
            }
            this.pendingUpdates.delete(filePath);
        }, delay);
        
        this.pendingUpdates.set(filePath, timeout);
        this.plugin.debugLogger.log('Scheduled property update for:', filePath, 'in', delay, 'ms');
    }

    /**
     * Execute property update with retry logic and comprehensive error handling
     */
    private async executeUpdate(file: TFile, mentions: string[], retryCount: number = 0): Promise<boolean> {
        const filePath = file.path;
        
        try {
            // Prevent concurrent updates
            if (this.updatingProperties.has(filePath)) {
                this.plugin.debugLogger.log('Skipping property update for', filePath, '- already updating');
                return false;
            }
            
            this.updatingProperties.add(filePath);
            this.plugin.debugLogger.log('Executing property update for:', filePath, 'with mentions:', mentions);
            
            // Validate file still exists
            if (!await this.plugin.app.vault.adapter.exists(filePath)) {
                this.plugin.debugLogger.log('File no longer exists:', filePath);
                return false;
            }
            
            const success = await this.updateFileProperties(file, mentions);
            
            if (success) {
                this.plugin.debugLogger.log('Property update completed successfully for:', filePath);
                return true;
            } else {
                throw new Error('Property update failed');
            }
            
        } catch (error) {
            this.plugin.debugLogger.log('Error in property update:', error);
            
            // Retry logic
            if (retryCount < this.MAX_RETRIES) {
                this.plugin.debugLogger.log(`Retrying property update for ${filePath} (attempt ${retryCount + 1}/${this.MAX_RETRIES})`);
                
                await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY * (retryCount + 1)));
                return await this.executeUpdate(file, mentions, retryCount + 1);
            } else {
                console.error(`Failed to update properties for ${filePath} after ${this.MAX_RETRIES} attempts:`, error);
                new Notice(`Failed to update properties for ${file.name}: ${error.message}`);
                return false;
            }
        } finally {
            this.updatingProperties.delete(filePath);
        }
    }

    /**
     * Safely parse and validate frontmatter
     */
    private parseFrontmatter(content: string): { frontmatter: any, bodyContent: string, hasValidFrontmatter: boolean } {
        const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
        const frontmatterMatch = content.match(frontmatterRegex);
        
        let frontmatter: any = {};
        let bodyContent = content;
        let hasValidFrontmatter = false;
        
        if (frontmatterMatch) {
            const frontmatterString = frontmatterMatch[1];
            bodyContent = content.replace(frontmatterRegex, '');
            
            try {
                const parsed = yaml.load(frontmatterString);
                
                // Validate parsed data
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    frontmatter = parsed;
                    hasValidFrontmatter = true;
                } else {
                    this.plugin.debugLogger.log('Invalid frontmatter structure, using empty object');
                    frontmatter = {};
                }
            } catch (error) {
                this.plugin.debugLogger.log('Error parsing YAML frontmatter:', error);
                // Try to preserve the original frontmatter if possible
                try {
                    // Attempt to parse as simple key-value pairs
                    frontmatter = this.parseSimpleFrontmatter(frontmatterString);
                    hasValidFrontmatter = true;
                } catch (fallbackError) {
                    this.plugin.debugLogger.log('Fallback parsing also failed, using empty object');
                    frontmatter = {};
                }
            }
        }
        
        return { frontmatter, bodyContent, hasValidFrontmatter };
    }

    /**
     * Fallback parser for simple frontmatter
     */
    private parseSimpleFrontmatter(frontmatterString: string): any {
        const result: any = {};
        const lines = frontmatterString.split('\n');
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                const colonIndex = trimmed.indexOf(':');
                if (colonIndex > 0) {
                    const key = trimmed.substring(0, colonIndex).trim();
                    const value = trimmed.substring(colonIndex + 1).trim();
                    
                    // Try to parse the value
                    try {
                        result[key] = yaml.load(value) || value;
                    } catch {
                        result[key] = value;
                    }
                }
            }
        }
        
        return result;
    }

    /**
     * Safely serialize frontmatter to YAML
     */
    private serializeFrontmatter(frontmatter: any): string {
        if (!frontmatter || Object.keys(frontmatter).length === 0) {
            return '';
        }
        
        try {
            const yamlString = yaml.dump(frontmatter, {
                flowLevel: -1,
                quotingType: '"',
                forceQuotes: false,
                sortKeys: true,
                lineWidth: -1
            });
            return `---\n${yamlString}---\n`;
        } catch (error) {
            this.plugin.debugLogger.log('Error serializing to YAML, using fallback:', error);
            
            // Fallback to simple serialization
            const lines = Object.entries(frontmatter).map(([key, value]) => {
                if (Array.isArray(value)) {
                    if (value.length === 0) {
                        return `${key}: []`;
                    }
                    const serializedItems = value.map(v => 
                        typeof v === 'string' ? `"${v.replace(/"/g, '\\"')}"` : String(v)
                    );
                    return `${key}: [${serializedItems.join(', ')}]`;
                } else if (typeof value === 'string') {
                    return `${key}: "${value.replace(/"/g, '\\"')}"`;
                } else {
                    return `${key}: ${String(value)}`;
                }
            });
            
            return `---\n${lines.join('\n')}\n---\n`;
        }
    }

    /**
     * Update file properties with enhanced error handling and validation
     */
    private async updateFileProperties(file: TFile, mentions: string[]): Promise<boolean> {
        try {
            // Read current file content with validation
            let content: string;
            try {
                content = await this.plugin.app.vault.read(file);
            } catch (error) {
                throw new Error(`Failed to read file: ${error.message}`);
            }
            
            // Parse frontmatter safely
            const { frontmatter, bodyContent, hasValidFrontmatter } = this.parseFrontmatter(content);
            
            // Update mentions in frontmatter
            const updatedFrontmatter = { ...frontmatter };
            
            if (mentions.length > 0) {
                updatedFrontmatter[this.plugin.settings.propertiesFieldName] = [...mentions]; // Create a copy
            } else {
                // Remove the mentions property if no mentions found
                delete updatedFrontmatter[this.plugin.settings.propertiesFieldName];
            }
            
            // Generate new content
            const newFrontmatter = this.serializeFrontmatter(updatedFrontmatter);
            const newContent = newFrontmatter + bodyContent;
            
            // Validate that content has actually changed
            if (newContent === content) {
                this.plugin.debugLogger.log('No changes needed for:', file.path);
                return true;
            }
            
            // Write updated content with validation
            try {
                await this.plugin.app.vault.modify(file, newContent);
                this.plugin.debugLogger.log('File properties updated successfully for:', file.path);
                return true;
            } catch (error) {
                throw new Error(`Failed to write file: ${error.message}`);
            }
            
        } catch (error) {
            this.plugin.debugLogger.log('Error in updateFileProperties:', error);
            throw error;
        }
    }

    /**
     * Clean up pending updates
     */
    cleanup(): void {
        // Clear all pending updates
        this.pendingUpdates.forEach((timeout) => {
            clearTimeout(timeout);
        });
        this.pendingUpdates.clear();
        this.updateQueue.clear();
        this.updatingProperties.clear();
    }

    /**
     * Get status information for debugging
     */
    getStatus(): { pendingUpdates: number, updatingFiles: number, queuedUpdates: number } {
        return {
            pendingUpdates: this.pendingUpdates.size,
            updatingFiles: this.updatingProperties.size,
            queuedUpdates: this.updateQueue.size
        };
    }
}

export default class MentionsPlugin extends Plugin {
    private mentionsView: MentionsView;
    private mentions: Mention[] = [];
    private mentionSuggest: MentionSuggest;
    private editorDecorations: Map<string, DecorationSet> = new Map();
    settings: MentionsPluginSettings;
    debugLogger: DebugLogger;
    private propertiesManager: FilePropertiesManager;
    // Legacy properties for backward compatibility
    private updatingProperties: Set<string> = new Set();
    private pendingPropertyUpdates: Map<string, NodeJS.Timeout> = new Map();

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
        // Updated regex to better handle mentions followed by other mentions or special characters
        const matches = content.match(/@[a-zа-я.-]+/g);
        if (!matches) return [];
        
        const mentions = matches.map(match => {
            // Remove @ symbol and any trailing punctuation that's not part of the mention
            const mention = match.substring(1);
            return mention.replace(/[.,!?;:]+$/, '');
        });
        
        // Filter out empty mentions and remove duplicates
        return [...new Set(mentions.filter(m => m.length > 0))];
    }

    /**
     * Schedule a delayed properties update using the new properties manager
     */
    schedulePropertyUpdate(file: TFile, delay: number = 1500): void {
        if (!this.settings.autoUpdateProperties) return;

        try {
            // Extract mentions from current content
            this.app.vault.read(file).then(content => {
                const mentions = this.extractMentionsFromContent(content);
                this.propertiesManager.scheduleUpdate(file, mentions, delay);
            }).catch(error => {
                this.debugLogger.log('Error reading file for property update:', error);
            });
        } catch (error) {
            this.debugLogger.log('Error in schedulePropertyUpdate:', error);
        }
    }

    /**
     * Legacy method - now delegates to the properties manager
     * Kept for backward compatibility
     */
    async updateFileProperties(file: TFile, mentions: string[]): Promise<void> {
        this.propertiesManager.scheduleUpdate(file, mentions, 0); // Immediate update
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

    /**
     * Check for content changes that might affect mentions and update properties accordingly
     */
    private async checkForContentChanges(view: MarkdownView): Promise<void> {
        if (!this.settings.autoUpdateProperties || !view.file) return;

        this.debugLogger.log('Checking for content changes that affect mentions');
        
        // Always schedule an update when content changes, regardless of what's in the current line
        // This ensures that deletions are also handled properly
        this.schedulePropertyUpdate(view.file, 1000);
    }

    async refreshAllMentions(): Promise<void> {
        this.debugLogger.log('Starting full mentions refresh...');
        
        // Clear existing mentions
        this.mentions = [];
        
        // Process all markdown files
        const files = this.app.vault.getMarkdownFiles();
        for (const file of files) {
            const content = await this.app.vault.read(file);
            const matches = content.match(/@[a-zа-я.-]+/g);
            if (matches) {
                matches.forEach(match => {
                    const cleanMatch = match; // match already contains @ symbol
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
        this.debugLogger.log('Searching for mentions:', {
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
        this.debugLogger.log('Showing mention results for:', mentionText);
        const results = this.searchMentions(mentionText);
        this.debugLogger.log('Search results:', results);
        
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
        
        // Initialize the enhanced properties manager
        this.propertiesManager = new FilePropertiesManager(this);
        
        this.addSettingTab(new MentionsSettingTab(this));
        
        this.debugLogger.log('MentionsPlugin loading...');

        // Add CSS for UI components (mention-tag styles are in styles.css)
        const mentionStyles = document.createElement('style');
        mentionStyles.textContent = `
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

        // Register simplified event handler for mention completion detection
        // Use only keyup event to avoid conflicts and reduce noise
        this.registerDomEvent(document, 'keyup', (evt: KeyboardEvent) => {
            // Trigger on space, enter, punctuation, or deletion keys
            if (evt.key === ' ' || evt.key === 'Enter' || /[.,!?;:]/.test(evt.key) || 
                evt.key === 'Backspace' || evt.key === 'Delete') {
                const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (activeView && activeView.file) {
                    // Longer delay to ensure the character is fully processed
                    setTimeout(() => {
                        this.checkForContentChanges(activeView);
                    }, 100);
                }
            }
        });

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
            this.debugLogger.log('Loading mentions from storage:', {
                savedMentions,
                hasData: !!savedMentions,
                dataType: typeof savedMentions
            });
            
            if (savedMentions) {
                this.mentions = savedMentions;
                this.debugLogger.log('Mentions loaded into memory:', this.mentions);
            }

            // Process all existing markdown files
            this.debugLogger.log('Processing existing files for mentions...');
            const files = this.app.vault.getMarkdownFiles();
            for (const file of files) {
                const content = await this.app.vault.read(file);
                const matches = content.match(/@[a-zа-я.-]+/g);
                if (matches) {
                    this.debugLogger.log(`Found mentions in ${file.path}:`, matches);
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
                this.debugLogger.log('Initial mentions found:', this.mentions);
                if (this.mentionsView) {
                    await this.mentionsView.setMentions(this.mentions);
                }
                await this.saveData(this.mentions);
            }

            // Register the markdown processor
            const processor = async (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
                this.debugLogger.log('MarkdownPostProcessor called for:', ctx.sourcePath);
                this.debugLogger.log('Element content:', el.innerHTML);
                this.debugLogger.log('Current mentions in memory:', this.mentions);

                // First, find all existing mention elements and remove them
                el.querySelectorAll('.mention-tag').forEach(el => el.remove());

                const codeBlocks = el.querySelectorAll('code');
                this.debugLogger.log('Found code blocks:', codeBlocks.length);
                
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
                            this.debugLogger.log('Checking node:', {
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
                    const matchResult = node.textContent?.match(/@[a-zа-я.-]+/g);
                    this.debugLogger.log(`Processing node ${nodeCount}:`, {
                        text: node.textContent,
                        matchResult
                    });
                    if (matchResult && matchResult.length > 0) {
                        nodesToProcess.push({node, matches: matchResult});
                    }
                }

                this.debugLogger.log(`Found ${nodesToProcess.length} nodes with mentions`);

                nodesToProcess.forEach(({node, matches}) => {
                    let pos = 0;
                    let text = node.textContent || '';
                    const fragment = document.createDocumentFragment();

                    matches.forEach((match: string) => {
                        // Add text before the mention
                        const beforeText = text.slice(pos, text.indexOf(match, pos));
                        if (beforeText) {
                            fragment.append(beforeText);
                        }

                        // Create the mention element
                        const mentionEl = document.createElement('span');
                        mentionEl.addClass('mention-tag');
                        mentionEl.textContent = match; // match already includes @ symbol
                        mentionEl.style.cursor = 'pointer';
                        mentionEl.setAttribute('data-mention', match);
                        
                        // Store the mention before adding the click handler
                        const position = text.indexOf(match, pos);
                        const mention = {
                            text: match,
                            file: ctx.sourcePath,
                            position: position
                        };
                        
                        // Only add if not already exists
                        const exists = this.mentions.some(m => 
                            m.text === match && 
                            m.file === ctx.sourcePath && 
                            m.position === position
                        );
                        
                        if (!exists) {
                            this.debugLogger.log('Adding new mention:', mention);
                            this.mentions.push(mention);
                            this.saveData(this.mentions);
                        }

                        const clickHandler = async (e: MouseEvent) => {
                            this.debugLogger.log('Click handler called');
                            e.preventDefault();
                            e.stopPropagation();
                            this.debugLogger.log('Mention clicked:', {
                                match: match,
                                fullText: match,
                                searchText: match.slice(1)
                            });
                            await this.showMentionResults(match.slice(1)); // Remove @ symbol
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
                    this.debugLogger.log('Found new mentions, current state:', {
                        newMentions: nodesToProcess.length,
                        totalMentions: this.mentions.length,
                        mentionsData: this.mentions
                    });
                    
                    if (this.mentionsView) {
                        this.mentionsView.setMentions(this.mentions);
                    }
                    
                    this.debugLogger.log('Saving mentions to storage...');
                    await this.saveData(this.mentions);
                    this.debugLogger.log('Mentions saved successfully');
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
                        
                        this.debugLogger.log('File modified:', file.path);
                        
                        // Get file content
                        const content = await this.app.vault.read(file);
                        this.debugLogger.log('Processing file content for mentions');
                        
                        // Remove old mentions for this file
                        this.mentions = this.mentions.filter(m => m.file !== file.path);
                        
                        // Find all mentions in the file
                        const matches = content.match(/@[a-zа-я.-]+/g);
                        if (matches) {
                            this.debugLogger.log('Found mentions in file:', matches);
                            
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
                        
                        this.debugLogger.log('Updated mentions:', this.mentions);
                        
                        // Update view and save
                        if (this.mentionsView) {
                            await this.mentionsView.setMentions(this.mentions);
                        }
                        await this.saveData(this.mentions);

                        // Note: Properties are now updated only when:
                        // 1. User selects a mention from autocomplete
                        // 2. User completes typing a mention (detected in MentionSuggest)
                        // This prevents premature updates during typing
                    }
                })
            );

            // Register for file deletion
            this.registerEvent(
                this.app.vault.on("delete", async (file) => {
                    if (file instanceof TFile && file.extension === 'md') {
                        this.debugLogger.log('File deleted:', file.path);
                        
                        // Remove all mentions from the deleted file
                        const beforeCount = this.mentions.length;
                        this.mentions = this.mentions.filter(m => m.file !== file.path);
                        const removedCount = beforeCount - this.mentions.length;
                        
                        if (removedCount > 0) {
                            this.debugLogger.log(`Removed ${removedCount} mentions from deleted file:`, file.path);
                            
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
                        this.debugLogger.log('New file created:', file.path);
                        const content = await this.app.vault.read(file);
                        const matches = content.match(/@[a-zа-я.-]+/g);
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

                            // Note: Properties are now updated only when:
                            // 1. User selects a mention from autocomplete
                            // 2. User completes typing a mention (detected in MentionSuggest)
                            // This prevents premature updates during typing
                        }
                    }
                })
            );

            // Register for file rename
            this.registerEvent(
                this.app.vault.on("rename", async (file, oldPath) => {
                    if (file instanceof TFile && file.extension === 'md') {
                        this.debugLogger.log('File renamed:', { oldPath, newPath: file.path });
                        
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

            this.debugLogger.log('MentionsPlugin loaded successfully');
        } catch (error) {
            console.error('Error during MentionsPlugin initialization:', error);
            new Notice('Error initializing Mentions plugin');
        }
    }

    onunload() {
        // Clean up the properties manager
        if (this.propertiesManager) {
            this.propertiesManager.cleanup();
        }
        
        // Clear legacy pending updates (for backward compatibility)
        this.pendingPropertyUpdates.forEach((timeout) => {
            clearTimeout(timeout);
        });
        this.pendingPropertyUpdates.clear();
        
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_MENTIONS);
    }

    private decorateMentions() {
        return StateField.define<DecorationSet>({
            create: () => Decoration.none,
            update: (decorations, tr) => {
                const text = tr.state.doc.toString();
                const matches = text.match(/@[a-zа-я.-]+/g);
                const decorationArray: any[] = [];

                if (matches) {
                    let pos = 0;
                    matches.forEach((match: string) => {
                        const start = text.indexOf(match, pos);
                        if (start >= 0) {
                            const end = start + match.length;
                            const mentionMark = Decoration.mark({
                                class: "mention-tag",
                                attributes: { "data-mention": match }
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