'use strict';

var obsidian = require('obsidian');

const DEFAULT_SETTINGS = {
    endpoint: "http://127.0.0.1:11434",
    model: "llama3.2",
    temperature: 0.2,
    tag: "#flashcards",
    heading: "## AI Flashcards",
};
class OllamaAutoFlashcards extends obsidian.Plugin {
    async onload() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        this.addCommand({
            id: "generate-flashcards-current-note",
            name: "Generate flashcards from current note",
            callback: () => this.generate(),
        });
        this.addSettingTab(new SettingsTab(this.app, this));
    }
    async saveSettings() {
        await this.saveData(this.settings);
    }
    /**
     * Main generation function.
     */
    async generate() {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
            new obsidian.Notice("No active note.");
            return;
        }
        if (file.extension !== "md") {
            new obsidian.Notice("The active file is not a Markdown note.");
            return;
        }
        const note = await this.app.vault.read(file);
        if (!note.trim()) {
            new obsidian.Notice("The current note is empty.");
            return;
        }
        /*
         * Calculate how many cards should be generated
         * before contacting Ollama.
         */
        const cardCount = this.calculateCardCount(note);
        new obsidian.Notice(`Generating approximately ${cardCount} flashcards...`);
        try {
            const generated = await this.generateCards(note, cardCount);
            if (generated.length === 0) {
                new obsidian.Notice("Ollama returned no usable flashcards.");
                return;
            }
            /*
             * Extract cards that already exist in the note.
             */
            const existing = this.extractCards(note);
            /*
             * Remove duplicates both against the note
             * and against other cards generated in this
             * same request.
             */
            const unique = [];
            for (const card of generated) {
                const duplicateExisting = existing.some(old => this.isDuplicate(card, old));
                if (duplicateExisting) {
                    continue;
                }
                const duplicateGenerated = unique.some(old => this.isDuplicate(card, old));
                if (duplicateGenerated) {
                    continue;
                }
                unique.push(card);
            }
            if (unique.length === 0) {
                new obsidian.Notice("No new flashcards were generated.");
                return;
            }
            /*
             * Append the cards to the note.
             */
            let output = note.trimEnd();
            /*
             * Add the deck tag if it doesn't already
             * exist.
             */
            if (!this.hasTag(output, this.settings.tag)) {
                output +=
                    `\n\n${this.settings.tag}`;
            }
            output +=
                `\n\n${this.settings.heading}\n\n`;
            for (const card of unique) {
                /*
                 * Spaced Repetition uses:
                 *
                 * Question::Answer
                 *
                 * Therefore "::" inside the generated
                 * content needs to be removed.
                 */
                const question = card.question
                    .replace(/::/g, ":")
                    .replace(/\n+/g, " ")
                    .trim();
                const answer = card.answer
                    .replace(/::/g, ":")
                    .replace(/\n+/g, " ")
                    .trim();
                output +=
                    `${question}::${answer}\n`;
            }
            await this.app.vault.modify(file, output);
            new obsidian.Notice(`Added ${unique.length} new flashcard${unique.length === 1
                ? ""
                : "s"}.`);
        }
        catch (error) {
            console.error("Ollama Auto Flashcards:", error);
            const message = error instanceof Error
                ? error.message
                : String(error);
            new obsidian.Notice(`Flashcard generation failed: ${message}`);
        }
    }
    /**
     * Determine an appropriate number of flashcards
     * from the note's length and information density.
     */
    calculateCardCount(note) {
        /*
         * Remove existing flashcards and irrelevant
         * metadata before calculating density.
         */
        const cleanNote = note
            .split("\n")
            .filter(line => {
            const trimmed = line.trim();
            if (!trimmed) {
                return false;
            }
            /*
             * Ignore code fences.
             */
            if (trimmed.startsWith("```")) {
                return false;
            }
            /*
             * Ignore the flashcard tag.
             */
            if (trimmed
                .startsWith("#flashcards")) {
                return false;
            }
            /*
             * Ignore existing
             * Question::Answer cards.
             */
            if (/^.*?::(?!:).*$/.test(trimmed)) {
                return false;
            }
            return true;
        })
            .join("\n");
        const words = cleanNote
            .split(/\s+/)
            .filter(Boolean);
        const wordCount = words.length;
        /*
         * Empty/very small notes.
         */
        if (wordCount === 0) {
            return 1;
        }
        /*
         * Analyze structure.
         */
        const lines = cleanNote.split("\n");
        /*
         * Markdown headings.
         */
        const headings = lines.filter(line => /^#{1,6}\s+/.test(line.trim())).length;
        /*
         * Bullet lists.
         */
        const listItems = lines.filter(line => /^[-*+]\s+/.test(line.trim()) ||
            /^\d+[.)]\s+/.test(line.trim())).length;
        /*
         * Definition-like language.
         */
        const definitionIndicators = (cleanNote.match(/\b(is|are|means|refers to|defined as|consists of|known as|called)\b/gi) ?? []).length;
        /*
         * Equations/formulas.
         */
        const formulas = (cleanNote.match(/[=→⇒∑∫√±×÷^]|\b[A-Za-z]\s*=\s*[A-Za-z0-9]/g) ?? []).length;
        /*
         * Base estimate:
         *
         * One card for roughly every 60 words.
         */
        let count = wordCount / 60;
        /*
         * Increase card count when the note has
         * many independently testable pieces of
         * information.
         */
        const densityBonus = headings * 0.5 +
            listItems * 0.15 +
            definitionIndicators * 0.25 +
            formulas * 0.5;
        count += densityBonus;
        /*
         * Minimums for progressively larger notes.
         */
        if (wordCount >= 50) {
            count =
                Math.max(count, 3);
        }
        if (wordCount >= 200) {
            count =
                Math.max(count, 5);
        }
        if (wordCount >= 500) {
            count =
                Math.max(count, 8);
        }
        if (wordCount >= 1000) {
            count =
                Math.max(count, 15);
        }
        if (wordCount >= 2000) {
            count =
                Math.max(count, 25);
        }
        /*
         * Hard maximum.
         *
         * This prevents a huge note from causing
         * an accidental enormous generation.
         */
        count =
            Math.min(count, 100);
        return Math.max(1, Math.round(count));
    }
    /**
     * Generate flashcards using Ollama.
     */
    async generateCards(note, cardCount) {
        /*
         * Remove existing flashcards before sending
         * the note to Ollama.
         *
         * This reduces context size and prevents the
         * model from wasting tokens looking at cards
         * that already exist.
         */
        const studyContent = this.removeExistingCards(note);
        const endpoint = this.settings.endpoint
            .replace(/\/+$/, "");
        const response = await fetch(`${endpoint}/api/chat`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: this.settings.model,
                stream: false,
                options: {
                    temperature: this.settings.temperature,
                },
                messages: [
                    {
                        role: "system",
                        content: `
You are a high-quality educational flashcard generator.

Your job is to transform study material into
useful active-recall flashcards.

Return ONLY valid JSON.

Never use Markdown fences.
Never include explanations outside the JSON.
`
                    },
                    {
                        role: "user",
                        content: `
Generate approximately ${cardCount} flashcards
from the study material below.

The target number was calculated automatically
from the length and information density of the note.

IMPORTANT:

- Cover the important information comprehensively.
- Prioritize concepts that are likely to matter in an exam.
- Test definitions.
- Test mechanisms.
- Test processes.
- Test relationships.
- Test comparisons.
- Test important dates.
- Test formulas.
- Test terminology.
- Test cause-and-effect relationships.
- Prefer active-recall questions.
- Avoid yes/no questions.
- Avoid trivial questions.
- Avoid questions whose answer is obvious from the question.
- Do not invent information.
- Only use information contained in the note.
- Do not make duplicate questions.
- Do not make near-duplicate questions.
- Do not generate filler cards.
- If the note does not contain enough information for the target
  number, generate fewer cards.
- If there is substantially more important information than the
  target number, prioritize the most important information.
- Never generate more than 100 cards.

Return exactly this JSON structure:

{
  "cards": [
    {
      "question": "Question",
      "answer": "Answer"
    }
  ]
}

STUDY MATERIAL:

<<<
${studyContent}
>>>
`
                    }
                ]
            })
        });
        if (!response.ok) {
            const body = await response.text();
            throw new Error(`Ollama returned HTTP ${response.status}: ${body.slice(0, 200)}`);
        }
        const data = await response.json();
        let text = data.message?.content?.trim() ??
            "";
        if (!text) {
            throw new Error("Ollama returned an empty response.");
        }
        /*
         * Some models still wrap JSON in:
         *
         * ```json
         * {...}
         * ```
         *
         * Remove that.
         */
        text =
            text
                .replace(/^```json\s*/i, "")
                .replace(/^```\s*/i, "")
                .replace(/\s*```$/i, "")
                .trim();
        /*
         * If the model added text before/after JSON,
         * try to extract the JSON object.
         */
        const start = text.indexOf("{");
        const end = text.lastIndexOf("}");
        if (start >= 0 &&
            end > start) {
            text =
                text.slice(start, end + 1);
        }
        let parsed;
        try {
            parsed =
                JSON.parse(text);
        }
        catch {
            throw new Error("Ollama returned invalid JSON.");
        }
        if (!Array.isArray(parsed.cards)) {
            throw new Error("Ollama did not return a cards array.");
        }
        return parsed.cards
            .filter((item) => {
            if (!item ||
                typeof item !==
                    "object") {
                return false;
            }
            const candidate = item;
            return (typeof candidate.question ===
                "string" &&
                typeof candidate.answer ===
                    "string");
        })
            .map(card => ({
            question: card.question
                .trim(),
            answer: card.answer
                .trim(),
        }))
            .filter(card => card.question.length >
            0 &&
            card.answer.length >
                0);
    }
    /**
     * Remove existing Question::Answer cards from
     * the text sent to Ollama.
     */
    removeExistingCards(note) {
        return note
            .split("\n")
            .filter(line => {
            const trimmed = line.trim();
            /*
             * Existing Spaced Repetition card.
             */
            if (/^.*?::(?!:).*$/.test(trimmed)) {
                return false;
            }
            /*
             * Don't send the generated-card
             * section to Ollama.
             */
            if (trimmed ===
                this.settings.heading) {
                return false;
            }
            return true;
        })
            .join("\n")
            .trim();
    }
    /**
     * Extract existing Spaced Repetition cards.
     */
    extractCards(note) {
        const cards = [];
        for (const line of note.split("\n")) {
            const match = line
                .trim()
                .match(/^(.*?)::(?!:)(.*)$/);
            if (match &&
                match[1].trim() &&
                match[2].trim()) {
                cards.push({
                    question: match[1].trim(),
                    answer: match[2].trim(),
                });
            }
        }
        return cards;
    }
    /**
     * Normalize text before comparing questions.
     */
    normalize(text) {
        return text
            .toLowerCase()
            .replace(/[`*_~]/g, "")
            .replace(/[^\p{L}\p{N}\s]/gu, " ")
            .replace(/\s+/g, " ")
            .trim();
    }
    /**
     * Detect duplicate or near-duplicate questions.
     */
    isDuplicate(a, b) {
        const x = this.normalize(a.question);
        const y = this.normalize(b.question);
        if (x === y) {
            return true;
        }
        /*
         * Catch cases where one question contains
         * the other with only a small wording change.
         */
        const shorter = x.length < y.length
            ? x
            : y;
        const longer = x.length < y.length
            ? y
            : x;
        if (shorter.length > 0 &&
            longer.includes(shorter) &&
            shorter.length /
                longer.length >= 0.8) {
            return true;
        }
        /*
         * Levenshtein similarity.
         */
        return (this.similarity(x, y) >= 0.88);
    }
    /**
     * Calculate normalized Levenshtein similarity.
     */
    similarity(a, b) {
        if (!a || !b) {
            return 0;
        }
        const longer = a.length >= b.length
            ? a
            : b;
        a.length >= b.length
            ? b
            : a;
        const distance = this.levenshtein(a, b);
        return (1 -
            distance /
                longer.length);
    }
    /**
     * Levenshtein edit distance.
     */
    levenshtein(a, b) {
        const previous = Array.from({
            length: b.length + 1,
        }, (_, i) => i);
        for (let i = 1; i <= a.length; i++) {
            const current = [i];
            for (let j = 1; j <= b.length; j++) {
                current[j] =
                    Math.min(current[j - 1] +
                        1, previous[j] +
                        1, previous[j - 1] +
                        (a[i - 1] ===
                            b[j - 1]
                            ? 0
                            : 1));
            }
            for (let j = 0; j <= b.length; j++) {
                previous[j] =
                    current[j];
            }
        }
        return previous[b.length];
    }
    /**
     * Check whether the note contains a tag.
     */
    hasTag(note, tag) {
        const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, "m").test(note);
    }
}
class SettingsTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        const el = this.containerEl;
        el.empty();
        el.createEl("h2", {
            text: "Ollama Auto Flashcards"
        });
        new obsidian.Setting(el)
            .setName("Ollama endpoint")
            .setDesc("Default: http://127.0.0.1:11434")
            .addText(text => text
            .setValue(this.plugin
            .settings
            .endpoint)
            .onChange(async (value) => {
            this.plugin
                .settings
                .endpoint =
                value.trim() ||
                    DEFAULT_SETTINGS
                        .endpoint;
            await this.plugin
                .saveSettings();
        }));
        new obsidian.Setting(el)
            .setName("Model")
            .setDesc("Any model installed in Ollama.")
            .addText(text => text
            .setValue(this.plugin
            .settings
            .model)
            .onChange(async (value) => {
            this.plugin
                .settings
                .model =
                value.trim() ||
                    DEFAULT_SETTINGS
                        .model;
            await this.plugin
                .saveSettings();
        }));
        new obsidian.Setting(el)
            .setName("Temperature")
            .setDesc("Lower values produce more deterministic cards. 0.1–0.3 is recommended.")
            .addText(text => text
            .setValue(String(this.plugin
            .settings
            .temperature))
            .onChange(async (value) => {
            const parsed = Number.parseFloat(value);
            this.plugin
                .settings
                .temperature =
                Number.isFinite(parsed)
                    ? Math.max(0, Math.min(1, parsed))
                    : DEFAULT_SETTINGS
                        .temperature;
            await this.plugin
                .saveSettings();
        }));
        new obsidian.Setting(el)
            .setName("Deck tag")
            .setDesc("Tag used for the flashcard deck.")
            .addText(text => text
            .setValue(this.plugin
            .settings
            .tag)
            .onChange(async (value) => {
            this.plugin
                .settings
                .tag =
                value.trim() ||
                    DEFAULT_SETTINGS
                        .tag;
            await this.plugin
                .saveSettings();
        }));
        new obsidian.Setting(el)
            .setName("Section heading")
            .setDesc("Heading used for generated cards.")
            .addText(text => text
            .setValue(this.plugin
            .settings
            .heading)
            .onChange(async (value) => {
            this.plugin
                .settings
                .heading =
                value.trim() ||
                    DEFAULT_SETTINGS
                        .heading;
            await this.plugin
                .saveSettings();
        }));
        el.createEl("p", {
            text: "The number of flashcards is automatically calculated from note length and information density."
        });
        el.createEl("p", {
            text: "Generated cards use Question::Answer syntax for compatibility with the Spaced Repetition plugin."
        });
    }
}

module.exports = OllamaAutoFlashcards;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsibWFpbi50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQge1xuICAgIEFwcCxcbiAgICBOb3RpY2UsXG4gICAgUGx1Z2luLFxuICAgIFBsdWdpblNldHRpbmdUYWIsXG4gICAgU2V0dGluZyxcbn0gZnJvbSBcIm9ic2lkaWFuXCI7XG5cbmludGVyZmFjZSBTZXR0aW5ncyB7XG4gICAgZW5kcG9pbnQ6IHN0cmluZztcbiAgICBtb2RlbDogc3RyaW5nO1xuICAgIHRlbXBlcmF0dXJlOiBudW1iZXI7XG4gICAgdGFnOiBzdHJpbmc7XG4gICAgaGVhZGluZzogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgQ2FyZCB7XG4gICAgcXVlc3Rpb246IHN0cmluZztcbiAgICBhbnN3ZXI6IHN0cmluZztcbn1cblxuY29uc3QgREVGQVVMVF9TRVRUSU5HUzogU2V0dGluZ3MgPSB7XG4gICAgZW5kcG9pbnQ6IFwiaHR0cDovLzEyNy4wLjAuMToxMTQzNFwiLFxuICAgIG1vZGVsOiBcImxsYW1hMy4yXCIsXG4gICAgdGVtcGVyYXR1cmU6IDAuMixcbiAgICB0YWc6IFwiI2ZsYXNoY2FyZHNcIixcbiAgICBoZWFkaW5nOiBcIiMjIEFJIEZsYXNoY2FyZHNcIixcbn07XG5cbmV4cG9ydCBkZWZhdWx0IGNsYXNzIE9sbGFtYUF1dG9GbGFzaGNhcmRzIGV4dGVuZHMgUGx1Z2luIHtcbiAgICBzZXR0aW5ncyE6IFNldHRpbmdzO1xuXG4gICAgYXN5bmMgb25sb2FkKCkge1xuICAgICAgICB0aGlzLnNldHRpbmdzID0gT2JqZWN0LmFzc2lnbihcbiAgICAgICAgICAgIHt9LFxuICAgICAgICAgICAgREVGQVVMVF9TRVRUSU5HUyxcbiAgICAgICAgICAgIGF3YWl0IHRoaXMubG9hZERhdGEoKVxuICAgICAgICApO1xuXG4gICAgICAgIHRoaXMuYWRkQ29tbWFuZCh7XG4gICAgICAgICAgICBpZDogXCJnZW5lcmF0ZS1mbGFzaGNhcmRzLWN1cnJlbnQtbm90ZVwiLFxuICAgICAgICAgICAgbmFtZTogXCJHZW5lcmF0ZSBmbGFzaGNhcmRzIGZyb20gY3VycmVudCBub3RlXCIsXG4gICAgICAgICAgICBjYWxsYmFjazogKCkgPT4gdGhpcy5nZW5lcmF0ZSgpLFxuICAgICAgICB9KTtcblxuICAgICAgICB0aGlzLmFkZFNldHRpbmdUYWIoXG4gICAgICAgICAgICBuZXcgU2V0dGluZ3NUYWIodGhpcy5hcHAsIHRoaXMpXG4gICAgICAgICk7XG4gICAgfVxuXG4gICAgYXN5bmMgc2F2ZVNldHRpbmdzKCkge1xuICAgICAgICBhd2FpdCB0aGlzLnNhdmVEYXRhKHRoaXMuc2V0dGluZ3MpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIE1haW4gZ2VuZXJhdGlvbiBmdW5jdGlvbi5cbiAgICAgKi9cbiAgICBwcml2YXRlIGFzeW5jIGdlbmVyYXRlKCkge1xuICAgICAgICBjb25zdCBmaWxlID1cbiAgICAgICAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5nZXRBY3RpdmVGaWxlKCk7XG5cbiAgICAgICAgaWYgKCFmaWxlKSB7XG4gICAgICAgICAgICBuZXcgTm90aWNlKFwiTm8gYWN0aXZlIG5vdGUuXCIpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGZpbGUuZXh0ZW5zaW9uICE9PSBcIm1kXCIpIHtcbiAgICAgICAgICAgIG5ldyBOb3RpY2UoXG4gICAgICAgICAgICAgICAgXCJUaGUgYWN0aXZlIGZpbGUgaXMgbm90IGEgTWFya2Rvd24gbm90ZS5cIlxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IG5vdGUgPVxuICAgICAgICAgICAgYXdhaXQgdGhpcy5hcHAudmF1bHQucmVhZChmaWxlKTtcblxuICAgICAgICBpZiAoIW5vdGUudHJpbSgpKSB7XG4gICAgICAgICAgICBuZXcgTm90aWNlKFxuICAgICAgICAgICAgICAgIFwiVGhlIGN1cnJlbnQgbm90ZSBpcyBlbXB0eS5cIlxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qXG4gICAgICAgICAqIENhbGN1bGF0ZSBob3cgbWFueSBjYXJkcyBzaG91bGQgYmUgZ2VuZXJhdGVkXG4gICAgICAgICAqIGJlZm9yZSBjb250YWN0aW5nIE9sbGFtYS5cbiAgICAgICAgICovXG4gICAgICAgIGNvbnN0IGNhcmRDb3VudCA9XG4gICAgICAgICAgICB0aGlzLmNhbGN1bGF0ZUNhcmRDb3VudChub3RlKTtcblxuICAgICAgICBuZXcgTm90aWNlKFxuICAgICAgICAgICAgYEdlbmVyYXRpbmcgYXBwcm94aW1hdGVseSAke2NhcmRDb3VudH0gZmxhc2hjYXJkcy4uLmBcbiAgICAgICAgKTtcblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgZ2VuZXJhdGVkID1cbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmdlbmVyYXRlQ2FyZHMoXG4gICAgICAgICAgICAgICAgICAgIG5vdGUsXG4gICAgICAgICAgICAgICAgICAgIGNhcmRDb3VudFxuICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGlmIChnZW5lcmF0ZWQubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICAgICAgbmV3IE5vdGljZShcbiAgICAgICAgICAgICAgICAgICAgXCJPbGxhbWEgcmV0dXJuZWQgbm8gdXNhYmxlIGZsYXNoY2FyZHMuXCJcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLypcbiAgICAgICAgICAgICAqIEV4dHJhY3QgY2FyZHMgdGhhdCBhbHJlYWR5IGV4aXN0IGluIHRoZSBub3RlLlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBjb25zdCBleGlzdGluZyA9XG4gICAgICAgICAgICAgICAgdGhpcy5leHRyYWN0Q2FyZHMobm90ZSk7XG5cbiAgICAgICAgICAgIC8qXG4gICAgICAgICAgICAgKiBSZW1vdmUgZHVwbGljYXRlcyBib3RoIGFnYWluc3QgdGhlIG5vdGVcbiAgICAgICAgICAgICAqIGFuZCBhZ2FpbnN0IG90aGVyIGNhcmRzIGdlbmVyYXRlZCBpbiB0aGlzXG4gICAgICAgICAgICAgKiBzYW1lIHJlcXVlc3QuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGNvbnN0IHVuaXF1ZTogQ2FyZFtdID0gW107XG5cbiAgICAgICAgICAgIGZvciAoY29uc3QgY2FyZCBvZiBnZW5lcmF0ZWQpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBkdXBsaWNhdGVFeGlzdGluZyA9XG4gICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nLnNvbWUoXG4gICAgICAgICAgICAgICAgICAgICAgICBvbGQgPT5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmlzRHVwbGljYXRlKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXJkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbGRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICBpZiAoZHVwbGljYXRlRXhpc3RpbmcpIHtcbiAgICAgICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29uc3QgZHVwbGljYXRlR2VuZXJhdGVkID1cbiAgICAgICAgICAgICAgICAgICAgdW5pcXVlLnNvbWUoXG4gICAgICAgICAgICAgICAgICAgICAgICBvbGQgPT5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmlzRHVwbGljYXRlKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXJkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbGRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICBpZiAoZHVwbGljYXRlR2VuZXJhdGVkKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHVuaXF1ZS5wdXNoKGNhcmQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAodW5pcXVlLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgICAgIG5ldyBOb3RpY2UoXG4gICAgICAgICAgICAgICAgICAgIFwiTm8gbmV3IGZsYXNoY2FyZHMgd2VyZSBnZW5lcmF0ZWQuXCJcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLypcbiAgICAgICAgICAgICAqIEFwcGVuZCB0aGUgY2FyZHMgdG8gdGhlIG5vdGUuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGxldCBvdXRwdXQgPVxuICAgICAgICAgICAgICAgIG5vdGUudHJpbUVuZCgpO1xuXG4gICAgICAgICAgICAvKlxuICAgICAgICAgICAgICogQWRkIHRoZSBkZWNrIHRhZyBpZiBpdCBkb2Vzbid0IGFscmVhZHlcbiAgICAgICAgICAgICAqIGV4aXN0LlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAgICAgIXRoaXMuaGFzVGFnKFxuICAgICAgICAgICAgICAgICAgICBvdXRwdXQsXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuc2V0dGluZ3MudGFnXG4gICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgICAgb3V0cHV0ICs9XG4gICAgICAgICAgICAgICAgICAgIGBcXG5cXG4ke3RoaXMuc2V0dGluZ3MudGFnfWA7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIG91dHB1dCArPVxuICAgICAgICAgICAgICAgIGBcXG5cXG4ke3RoaXMuc2V0dGluZ3MuaGVhZGluZ31cXG5cXG5gO1xuXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGNhcmQgb2YgdW5pcXVlKSB7XG4gICAgICAgICAgICAgICAgLypcbiAgICAgICAgICAgICAgICAgKiBTcGFjZWQgUmVwZXRpdGlvbiB1c2VzOlxuICAgICAgICAgICAgICAgICAqXG4gICAgICAgICAgICAgICAgICogUXVlc3Rpb246OkFuc3dlclxuICAgICAgICAgICAgICAgICAqXG4gICAgICAgICAgICAgICAgICogVGhlcmVmb3JlIFwiOjpcIiBpbnNpZGUgdGhlIGdlbmVyYXRlZFxuICAgICAgICAgICAgICAgICAqIGNvbnRlbnQgbmVlZHMgdG8gYmUgcmVtb3ZlZC5cbiAgICAgICAgICAgICAgICAgKi9cbiAgICAgICAgICAgICAgICBjb25zdCBxdWVzdGlvbiA9XG4gICAgICAgICAgICAgICAgICAgIGNhcmQucXVlc3Rpb25cbiAgICAgICAgICAgICAgICAgICAgICAgIC5yZXBsYWNlKC86Oi9nLCBcIjpcIilcbiAgICAgICAgICAgICAgICAgICAgICAgIC5yZXBsYWNlKC9cXG4rL2csIFwiIFwiKVxuICAgICAgICAgICAgICAgICAgICAgICAgLnRyaW0oKTtcblxuICAgICAgICAgICAgICAgIGNvbnN0IGFuc3dlciA9XG4gICAgICAgICAgICAgICAgICAgIGNhcmQuYW5zd2VyXG4gICAgICAgICAgICAgICAgICAgICAgICAucmVwbGFjZSgvOjovZywgXCI6XCIpXG4gICAgICAgICAgICAgICAgICAgICAgICAucmVwbGFjZSgvXFxuKy9nLCBcIiBcIilcbiAgICAgICAgICAgICAgICAgICAgICAgIC50cmltKCk7XG5cbiAgICAgICAgICAgICAgICBvdXRwdXQgKz1cbiAgICAgICAgICAgICAgICAgICAgYCR7cXVlc3Rpb259Ojoke2Fuc3dlcn1cXG5gO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLmFwcC52YXVsdC5tb2RpZnkoXG4gICAgICAgICAgICAgICAgZmlsZSxcbiAgICAgICAgICAgICAgICBvdXRwdXRcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIG5ldyBOb3RpY2UoXG4gICAgICAgICAgICAgICAgYEFkZGVkICR7dW5pcXVlLmxlbmd0aH0gbmV3IGZsYXNoY2FyZCR7XG4gICAgICAgICAgICAgICAgICAgIHVuaXF1ZS5sZW5ndGggPT09IDFcbiAgICAgICAgICAgICAgICAgICAgICAgID8gXCJcIlxuICAgICAgICAgICAgICAgICAgICAgICAgOiBcInNcIlxuICAgICAgICAgICAgICAgIH0uYFxuICAgICAgICAgICAgKTtcblxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgY29uc29sZS5lcnJvcihcbiAgICAgICAgICAgICAgICBcIk9sbGFtYSBBdXRvIEZsYXNoY2FyZHM6XCIsXG4gICAgICAgICAgICAgICAgZXJyb3JcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGNvbnN0IG1lc3NhZ2UgPVxuICAgICAgICAgICAgICAgIGVycm9yIGluc3RhbmNlb2YgRXJyb3JcbiAgICAgICAgICAgICAgICAgICAgPyBlcnJvci5tZXNzYWdlXG4gICAgICAgICAgICAgICAgICAgIDogU3RyaW5nKGVycm9yKTtcblxuICAgICAgICAgICAgbmV3IE5vdGljZShcbiAgICAgICAgICAgICAgICBgRmxhc2hjYXJkIGdlbmVyYXRpb24gZmFpbGVkOiAke21lc3NhZ2V9YFxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIERldGVybWluZSBhbiBhcHByb3ByaWF0ZSBudW1iZXIgb2YgZmxhc2hjYXJkc1xuICAgICAqIGZyb20gdGhlIG5vdGUncyBsZW5ndGggYW5kIGluZm9ybWF0aW9uIGRlbnNpdHkuXG4gICAgICovXG4gICAgcHJpdmF0ZSBjYWxjdWxhdGVDYXJkQ291bnQoXG4gICAgICAgIG5vdGU6IHN0cmluZ1xuICAgICk6IG51bWJlciB7XG5cbiAgICAgICAgLypcbiAgICAgICAgICogUmVtb3ZlIGV4aXN0aW5nIGZsYXNoY2FyZHMgYW5kIGlycmVsZXZhbnRcbiAgICAgICAgICogbWV0YWRhdGEgYmVmb3JlIGNhbGN1bGF0aW5nIGRlbnNpdHkuXG4gICAgICAgICAqL1xuICAgICAgICBjb25zdCBjbGVhbk5vdGUgPVxuICAgICAgICAgICAgbm90ZVxuICAgICAgICAgICAgICAgIC5zcGxpdChcIlxcblwiKVxuICAgICAgICAgICAgICAgIC5maWx0ZXIobGluZSA9PiB7XG5cbiAgICAgICAgICAgICAgICAgICAgY29uc3QgdHJpbW1lZCA9XG4gICAgICAgICAgICAgICAgICAgICAgICBsaW5lLnRyaW0oKTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoIXRyaW1tZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIC8qXG4gICAgICAgICAgICAgICAgICAgICAqIElnbm9yZSBjb2RlIGZlbmNlcy5cbiAgICAgICAgICAgICAgICAgICAgICovXG4gICAgICAgICAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgICAgICAgICAgIHRyaW1tZWQuc3RhcnRzV2l0aChcImBgYFwiKVxuICAgICAgICAgICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIC8qXG4gICAgICAgICAgICAgICAgICAgICAqIElnbm9yZSB0aGUgZmxhc2hjYXJkIHRhZy5cbiAgICAgICAgICAgICAgICAgICAgICovXG4gICAgICAgICAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgICAgICAgICAgIHRyaW1tZWRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuc3RhcnRzV2l0aChcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXCIjZmxhc2hjYXJkc1wiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIC8qXG4gICAgICAgICAgICAgICAgICAgICAqIElnbm9yZSBleGlzdGluZ1xuICAgICAgICAgICAgICAgICAgICAgKiBRdWVzdGlvbjo6QW5zd2VyIGNhcmRzLlxuICAgICAgICAgICAgICAgICAgICAgKi9cbiAgICAgICAgICAgICAgICAgICAgaWYgKFxuICAgICAgICAgICAgICAgICAgICAgICAgL14uKj86Oig/ITopLiokLy50ZXN0KFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRyaW1tZWRcbiAgICAgICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAgIC5qb2luKFwiXFxuXCIpO1xuXG4gICAgICAgIGNvbnN0IHdvcmRzID1cbiAgICAgICAgICAgIGNsZWFuTm90ZVxuICAgICAgICAgICAgICAgIC5zcGxpdCgvXFxzKy8pXG4gICAgICAgICAgICAgICAgLmZpbHRlcihCb29sZWFuKTtcblxuICAgICAgICBjb25zdCB3b3JkQ291bnQgPVxuICAgICAgICAgICAgd29yZHMubGVuZ3RoO1xuXG4gICAgICAgIC8qXG4gICAgICAgICAqIEVtcHR5L3Zlcnkgc21hbGwgbm90ZXMuXG4gICAgICAgICAqL1xuICAgICAgICBpZiAod29yZENvdW50ID09PSAwKSB7XG4gICAgICAgICAgICByZXR1cm4gMTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qXG4gICAgICAgICAqIEFuYWx5emUgc3RydWN0dXJlLlxuICAgICAgICAgKi9cbiAgICAgICAgY29uc3QgbGluZXMgPVxuICAgICAgICAgICAgY2xlYW5Ob3RlLnNwbGl0KFwiXFxuXCIpO1xuXG4gICAgICAgIC8qXG4gICAgICAgICAqIE1hcmtkb3duIGhlYWRpbmdzLlxuICAgICAgICAgKi9cbiAgICAgICAgY29uc3QgaGVhZGluZ3MgPVxuICAgICAgICAgICAgbGluZXMuZmlsdGVyKGxpbmUgPT5cbiAgICAgICAgICAgICAgICAvXiN7MSw2fVxccysvLnRlc3QoXG4gICAgICAgICAgICAgICAgICAgIGxpbmUudHJpbSgpXG4gICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgKS5sZW5ndGg7XG5cbiAgICAgICAgLypcbiAgICAgICAgICogQnVsbGV0IGxpc3RzLlxuICAgICAgICAgKi9cbiAgICAgICAgY29uc3QgbGlzdEl0ZW1zID1cbiAgICAgICAgICAgIGxpbmVzLmZpbHRlcihsaW5lID0+XG4gICAgICAgICAgICAgICAgL15bLSorXVxccysvLnRlc3QoXG4gICAgICAgICAgICAgICAgICAgIGxpbmUudHJpbSgpXG4gICAgICAgICAgICAgICAgKSB8fFxuICAgICAgICAgICAgICAgIC9eXFxkK1suKV1cXHMrLy50ZXN0KFxuICAgICAgICAgICAgICAgICAgICBsaW5lLnRyaW0oKVxuICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICkubGVuZ3RoO1xuXG4gICAgICAgIC8qXG4gICAgICAgICAqIERlZmluaXRpb24tbGlrZSBsYW5ndWFnZS5cbiAgICAgICAgICovXG4gICAgICAgIGNvbnN0IGRlZmluaXRpb25JbmRpY2F0b3JzID1cbiAgICAgICAgICAgIChcbiAgICAgICAgICAgICAgICBjbGVhbk5vdGUubWF0Y2goXG4gICAgICAgICAgICAgICAgICAgIC9cXGIoaXN8YXJlfG1lYW5zfHJlZmVycyB0b3xkZWZpbmVkIGFzfGNvbnNpc3RzIG9mfGtub3duIGFzfGNhbGxlZClcXGIvZ2lcbiAgICAgICAgICAgICAgICApID8/IFtdXG4gICAgICAgICAgICApLmxlbmd0aDtcblxuICAgICAgICAvKlxuICAgICAgICAgKiBFcXVhdGlvbnMvZm9ybXVsYXMuXG4gICAgICAgICAqL1xuICAgICAgICBjb25zdCBmb3JtdWxhcyA9XG4gICAgICAgICAgICAoXG4gICAgICAgICAgICAgICAgY2xlYW5Ob3RlLm1hdGNoKFxuICAgICAgICAgICAgICAgICAgICAvWz3ihpLih5LiiJHiiKviiJrCscOXw7deXXxcXGJbQS1aYS16XVxccyo9XFxzKltBLVphLXowLTldL2dcbiAgICAgICAgICAgICAgICApID8/IFtdXG4gICAgICAgICAgICApLmxlbmd0aDtcblxuICAgICAgICAvKlxuICAgICAgICAgKiBCYXNlIGVzdGltYXRlOlxuICAgICAgICAgKlxuICAgICAgICAgKiBPbmUgY2FyZCBmb3Igcm91Z2hseSBldmVyeSA2MCB3b3Jkcy5cbiAgICAgICAgICovXG4gICAgICAgIGxldCBjb3VudCA9XG4gICAgICAgICAgICB3b3JkQ291bnQgLyA2MDtcblxuICAgICAgICAvKlxuICAgICAgICAgKiBJbmNyZWFzZSBjYXJkIGNvdW50IHdoZW4gdGhlIG5vdGUgaGFzXG4gICAgICAgICAqIG1hbnkgaW5kZXBlbmRlbnRseSB0ZXN0YWJsZSBwaWVjZXMgb2ZcbiAgICAgICAgICogaW5mb3JtYXRpb24uXG4gICAgICAgICAqL1xuICAgICAgICBjb25zdCBkZW5zaXR5Qm9udXMgPVxuICAgICAgICAgICAgaGVhZGluZ3MgKiAwLjUgK1xuICAgICAgICAgICAgbGlzdEl0ZW1zICogMC4xNSArXG4gICAgICAgICAgICBkZWZpbml0aW9uSW5kaWNhdG9ycyAqIDAuMjUgK1xuICAgICAgICAgICAgZm9ybXVsYXMgKiAwLjU7XG5cbiAgICAgICAgY291bnQgKz0gZGVuc2l0eUJvbnVzO1xuXG4gICAgICAgIC8qXG4gICAgICAgICAqIE1pbmltdW1zIGZvciBwcm9ncmVzc2l2ZWx5IGxhcmdlciBub3Rlcy5cbiAgICAgICAgICovXG4gICAgICAgIGlmICh3b3JkQ291bnQgPj0gNTApIHtcbiAgICAgICAgICAgIGNvdW50ID1cbiAgICAgICAgICAgICAgICBNYXRoLm1heChjb3VudCwgMyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAod29yZENvdW50ID49IDIwMCkge1xuICAgICAgICAgICAgY291bnQgPVxuICAgICAgICAgICAgICAgIE1hdGgubWF4KGNvdW50LCA1KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh3b3JkQ291bnQgPj0gNTAwKSB7XG4gICAgICAgICAgICBjb3VudCA9XG4gICAgICAgICAgICAgICAgTWF0aC5tYXgoY291bnQsIDgpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHdvcmRDb3VudCA+PSAxMDAwKSB7XG4gICAgICAgICAgICBjb3VudCA9XG4gICAgICAgICAgICAgICAgTWF0aC5tYXgoY291bnQsIDE1KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh3b3JkQ291bnQgPj0gMjAwMCkge1xuICAgICAgICAgICAgY291bnQgPVxuICAgICAgICAgICAgICAgIE1hdGgubWF4KGNvdW50LCAyNSk7XG4gICAgICAgIH1cblxuICAgICAgICAvKlxuICAgICAgICAgKiBIYXJkIG1heGltdW0uXG4gICAgICAgICAqXG4gICAgICAgICAqIFRoaXMgcHJldmVudHMgYSBodWdlIG5vdGUgZnJvbSBjYXVzaW5nXG4gICAgICAgICAqIGFuIGFjY2lkZW50YWwgZW5vcm1vdXMgZ2VuZXJhdGlvbi5cbiAgICAgICAgICovXG4gICAgICAgIGNvdW50ID1cbiAgICAgICAgICAgIE1hdGgubWluKGNvdW50LCAxMDApO1xuXG4gICAgICAgIHJldHVybiBNYXRoLm1heChcbiAgICAgICAgICAgIDEsXG4gICAgICAgICAgICBNYXRoLnJvdW5kKGNvdW50KVxuICAgICAgICApO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdlbmVyYXRlIGZsYXNoY2FyZHMgdXNpbmcgT2xsYW1hLlxuICAgICAqL1xuICAgIHByaXZhdGUgYXN5bmMgZ2VuZXJhdGVDYXJkcyhcbiAgICAgICAgbm90ZTogc3RyaW5nLFxuICAgICAgICBjYXJkQ291bnQ6IG51bWJlclxuICAgICk6IFByb21pc2U8Q2FyZFtdPiB7XG5cbiAgICAgICAgLypcbiAgICAgICAgICogUmVtb3ZlIGV4aXN0aW5nIGZsYXNoY2FyZHMgYmVmb3JlIHNlbmRpbmdcbiAgICAgICAgICogdGhlIG5vdGUgdG8gT2xsYW1hLlxuICAgICAgICAgKlxuICAgICAgICAgKiBUaGlzIHJlZHVjZXMgY29udGV4dCBzaXplIGFuZCBwcmV2ZW50cyB0aGVcbiAgICAgICAgICogbW9kZWwgZnJvbSB3YXN0aW5nIHRva2VucyBsb29raW5nIGF0IGNhcmRzXG4gICAgICAgICAqIHRoYXQgYWxyZWFkeSBleGlzdC5cbiAgICAgICAgICovXG4gICAgICAgIGNvbnN0IHN0dWR5Q29udGVudCA9XG4gICAgICAgICAgICB0aGlzLnJlbW92ZUV4aXN0aW5nQ2FyZHMobm90ZSk7XG5cbiAgICAgICAgY29uc3QgZW5kcG9pbnQgPVxuICAgICAgICAgICAgdGhpcy5zZXR0aW5ncy5lbmRwb2ludFxuICAgICAgICAgICAgICAgIC5yZXBsYWNlKC9cXC8rJC8sIFwiXCIpO1xuXG4gICAgICAgIGNvbnN0IHJlc3BvbnNlID1cbiAgICAgICAgICAgIGF3YWl0IGZldGNoKFxuICAgICAgICAgICAgICAgIGAke2VuZHBvaW50fS9hcGkvY2hhdGAsXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICBtZXRob2Q6IFwiUE9TVFwiLFxuXG4gICAgICAgICAgICAgICAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFwiQ29udGVudC1UeXBlXCI6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gICAgICAgICAgICAgICAgICAgIH0sXG5cbiAgICAgICAgICAgICAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBtb2RlbDpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLnNldHRpbmdzLm1vZGVsLFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBzdHJlYW06IGZhbHNlLFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBvcHRpb25zOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGVtcGVyYXR1cmU6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuc2V0dGluZ3MudGVtcGVyYXR1cmUsXG4gICAgICAgICAgICAgICAgICAgICAgICB9LFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBtZXNzYWdlczogW1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByb2xlOiBcInN5c3RlbVwiLFxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRlbnQ6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBgXG5Zb3UgYXJlIGEgaGlnaC1xdWFsaXR5IGVkdWNhdGlvbmFsIGZsYXNoY2FyZCBnZW5lcmF0b3IuXG5cbllvdXIgam9iIGlzIHRvIHRyYW5zZm9ybSBzdHVkeSBtYXRlcmlhbCBpbnRvXG51c2VmdWwgYWN0aXZlLXJlY2FsbCBmbGFzaGNhcmRzLlxuXG5SZXR1cm4gT05MWSB2YWxpZCBKU09OLlxuXG5OZXZlciB1c2UgTWFya2Rvd24gZmVuY2VzLlxuTmV2ZXIgaW5jbHVkZSBleHBsYW5hdGlvbnMgb3V0c2lkZSB0aGUgSlNPTi5cbmBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByb2xlOiBcInVzZXJcIixcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb250ZW50OlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYFxuR2VuZXJhdGUgYXBwcm94aW1hdGVseSAke2NhcmRDb3VudH0gZmxhc2hjYXJkc1xuZnJvbSB0aGUgc3R1ZHkgbWF0ZXJpYWwgYmVsb3cuXG5cblRoZSB0YXJnZXQgbnVtYmVyIHdhcyBjYWxjdWxhdGVkIGF1dG9tYXRpY2FsbHlcbmZyb20gdGhlIGxlbmd0aCBhbmQgaW5mb3JtYXRpb24gZGVuc2l0eSBvZiB0aGUgbm90ZS5cblxuSU1QT1JUQU5UOlxuXG4tIENvdmVyIHRoZSBpbXBvcnRhbnQgaW5mb3JtYXRpb24gY29tcHJlaGVuc2l2ZWx5LlxuLSBQcmlvcml0aXplIGNvbmNlcHRzIHRoYXQgYXJlIGxpa2VseSB0byBtYXR0ZXIgaW4gYW4gZXhhbS5cbi0gVGVzdCBkZWZpbml0aW9ucy5cbi0gVGVzdCBtZWNoYW5pc21zLlxuLSBUZXN0IHByb2Nlc3Nlcy5cbi0gVGVzdCByZWxhdGlvbnNoaXBzLlxuLSBUZXN0IGNvbXBhcmlzb25zLlxuLSBUZXN0IGltcG9ydGFudCBkYXRlcy5cbi0gVGVzdCBmb3JtdWxhcy5cbi0gVGVzdCB0ZXJtaW5vbG9neS5cbi0gVGVzdCBjYXVzZS1hbmQtZWZmZWN0IHJlbGF0aW9uc2hpcHMuXG4tIFByZWZlciBhY3RpdmUtcmVjYWxsIHF1ZXN0aW9ucy5cbi0gQXZvaWQgeWVzL25vIHF1ZXN0aW9ucy5cbi0gQXZvaWQgdHJpdmlhbCBxdWVzdGlvbnMuXG4tIEF2b2lkIHF1ZXN0aW9ucyB3aG9zZSBhbnN3ZXIgaXMgb2J2aW91cyBmcm9tIHRoZSBxdWVzdGlvbi5cbi0gRG8gbm90IGludmVudCBpbmZvcm1hdGlvbi5cbi0gT25seSB1c2UgaW5mb3JtYXRpb24gY29udGFpbmVkIGluIHRoZSBub3RlLlxuLSBEbyBub3QgbWFrZSBkdXBsaWNhdGUgcXVlc3Rpb25zLlxuLSBEbyBub3QgbWFrZSBuZWFyLWR1cGxpY2F0ZSBxdWVzdGlvbnMuXG4tIERvIG5vdCBnZW5lcmF0ZSBmaWxsZXIgY2FyZHMuXG4tIElmIHRoZSBub3RlIGRvZXMgbm90IGNvbnRhaW4gZW5vdWdoIGluZm9ybWF0aW9uIGZvciB0aGUgdGFyZ2V0XG4gIG51bWJlciwgZ2VuZXJhdGUgZmV3ZXIgY2FyZHMuXG4tIElmIHRoZXJlIGlzIHN1YnN0YW50aWFsbHkgbW9yZSBpbXBvcnRhbnQgaW5mb3JtYXRpb24gdGhhbiB0aGVcbiAgdGFyZ2V0IG51bWJlciwgcHJpb3JpdGl6ZSB0aGUgbW9zdCBpbXBvcnRhbnQgaW5mb3JtYXRpb24uXG4tIE5ldmVyIGdlbmVyYXRlIG1vcmUgdGhhbiAxMDAgY2FyZHMuXG5cblJldHVybiBleGFjdGx5IHRoaXMgSlNPTiBzdHJ1Y3R1cmU6XG5cbntcbiAgXCJjYXJkc1wiOiBbXG4gICAge1xuICAgICAgXCJxdWVzdGlvblwiOiBcIlF1ZXN0aW9uXCIsXG4gICAgICBcImFuc3dlclwiOiBcIkFuc3dlclwiXG4gICAgfVxuICBdXG59XG5cblNUVURZIE1BVEVSSUFMOlxuXG48PDxcbiR7c3R1ZHlDb250ZW50fVxuPj4+XG5gXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgXVxuICAgICAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgICAgICAgICAgY29uc3QgYm9keSA9XG4gICAgICAgICAgICAgICAgYXdhaXQgcmVzcG9uc2UudGV4dCgpO1xuXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgYE9sbGFtYSByZXR1cm5lZCBIVFRQICR7cmVzcG9uc2Uuc3RhdHVzfTogJHtib2R5LnNsaWNlKFxuICAgICAgICAgICAgICAgICAgICAwLFxuICAgICAgICAgICAgICAgICAgICAyMDBcbiAgICAgICAgICAgICAgICApfWBcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBkYXRhID1cbiAgICAgICAgICAgIGF3YWl0IHJlc3BvbnNlLmpzb24oKSBhcyB7XG4gICAgICAgICAgICAgICAgbWVzc2FnZT86IHtcbiAgICAgICAgICAgICAgICAgICAgY29udGVudD86IHN0cmluZztcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfTtcblxuICAgICAgICBsZXQgdGV4dCA9XG4gICAgICAgICAgICBkYXRhLm1lc3NhZ2U/LmNvbnRlbnQ/LnRyaW0oKSA/P1xuICAgICAgICAgICAgXCJcIjtcblxuICAgICAgICBpZiAoIXRleHQpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICBcIk9sbGFtYSByZXR1cm5lZCBhbiBlbXB0eSByZXNwb25zZS5cIlxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qXG4gICAgICAgICAqIFNvbWUgbW9kZWxzIHN0aWxsIHdyYXAgSlNPTiBpbjpcbiAgICAgICAgICpcbiAgICAgICAgICogYGBganNvblxuICAgICAgICAgKiB7Li4ufVxuICAgICAgICAgKiBgYGBcbiAgICAgICAgICpcbiAgICAgICAgICogUmVtb3ZlIHRoYXQuXG4gICAgICAgICAqL1xuICAgICAgICB0ZXh0ID1cbiAgICAgICAgICAgIHRleHRcbiAgICAgICAgICAgICAgICAucmVwbGFjZShcbiAgICAgICAgICAgICAgICAgICAgL15gYGBqc29uXFxzKi9pLFxuICAgICAgICAgICAgICAgICAgICBcIlwiXG4gICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgIC5yZXBsYWNlKFxuICAgICAgICAgICAgICAgICAgICAvXmBgYFxccyovaSxcbiAgICAgICAgICAgICAgICAgICAgXCJcIlxuICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICAucmVwbGFjZShcbiAgICAgICAgICAgICAgICAgICAgL1xccypgYGAkL2ksXG4gICAgICAgICAgICAgICAgICAgIFwiXCJcbiAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgLnRyaW0oKTtcblxuICAgICAgICAvKlxuICAgICAgICAgKiBJZiB0aGUgbW9kZWwgYWRkZWQgdGV4dCBiZWZvcmUvYWZ0ZXIgSlNPTixcbiAgICAgICAgICogdHJ5IHRvIGV4dHJhY3QgdGhlIEpTT04gb2JqZWN0LlxuICAgICAgICAgKi9cbiAgICAgICAgY29uc3Qgc3RhcnQgPVxuICAgICAgICAgICAgdGV4dC5pbmRleE9mKFwie1wiKTtcblxuICAgICAgICBjb25zdCBlbmQgPVxuICAgICAgICAgICAgdGV4dC5sYXN0SW5kZXhPZihcIn1cIik7XG5cbiAgICAgICAgaWYgKFxuICAgICAgICAgICAgc3RhcnQgPj0gMCAmJlxuICAgICAgICAgICAgZW5kID4gc3RhcnRcbiAgICAgICAgKSB7XG4gICAgICAgICAgICB0ZXh0ID1cbiAgICAgICAgICAgICAgICB0ZXh0LnNsaWNlKFxuICAgICAgICAgICAgICAgICAgICBzdGFydCxcbiAgICAgICAgICAgICAgICAgICAgZW5kICsgMVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcGFyc2VkOiB7XG4gICAgICAgICAgICBjYXJkcz86IHVua25vd247XG4gICAgICAgIH07XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHBhcnNlZCA9XG4gICAgICAgICAgICAgICAgSlNPTi5wYXJzZSh0ZXh0KTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgXCJPbGxhbWEgcmV0dXJuZWQgaW52YWxpZCBKU09OLlwiXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKFxuICAgICAgICAgICAgIUFycmF5LmlzQXJyYXkoXG4gICAgICAgICAgICAgICAgcGFyc2VkLmNhcmRzXG4gICAgICAgICAgICApXG4gICAgICAgICkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICAgIFwiT2xsYW1hIGRpZCBub3QgcmV0dXJuIGEgY2FyZHMgYXJyYXkuXCJcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcGFyc2VkLmNhcmRzXG4gICAgICAgICAgICAuZmlsdGVyKFxuICAgICAgICAgICAgICAgIChcbiAgICAgICAgICAgICAgICAgICAgaXRlbVxuICAgICAgICAgICAgICAgICk6IGl0ZW0gaXMgQ2FyZCA9PiB7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKFxuICAgICAgICAgICAgICAgICAgICAgICAgIWl0ZW0gfHxcbiAgICAgICAgICAgICAgICAgICAgICAgIHR5cGVvZiBpdGVtICE9PVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwib2JqZWN0XCJcbiAgICAgICAgICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBjb25zdCBjYW5kaWRhdGUgPVxuICAgICAgICAgICAgICAgICAgICAgICAgaXRlbSBhcyBQYXJ0aWFsPENhcmQ+O1xuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAoXG4gICAgICAgICAgICAgICAgICAgICAgICB0eXBlb2YgY2FuZGlkYXRlLnF1ZXN0aW9uID09PVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwic3RyaW5nXCIgJiZcbiAgICAgICAgICAgICAgICAgICAgICAgIHR5cGVvZiBjYW5kaWRhdGUuYW5zd2VyID09PVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwic3RyaW5nXCJcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICApXG4gICAgICAgICAgICAubWFwKGNhcmQgPT4gKHtcbiAgICAgICAgICAgICAgICBxdWVzdGlvbjpcbiAgICAgICAgICAgICAgICAgICAgY2FyZC5xdWVzdGlvblxuICAgICAgICAgICAgICAgICAgICAgICAgLnRyaW0oKSxcblxuICAgICAgICAgICAgICAgIGFuc3dlcjpcbiAgICAgICAgICAgICAgICAgICAgY2FyZC5hbnN3ZXJcbiAgICAgICAgICAgICAgICAgICAgICAgIC50cmltKCksXG4gICAgICAgICAgICB9KSlcbiAgICAgICAgICAgIC5maWx0ZXIoXG4gICAgICAgICAgICAgICAgY2FyZCA9PlxuICAgICAgICAgICAgICAgICAgICBjYXJkLnF1ZXN0aW9uLmxlbmd0aCA+XG4gICAgICAgICAgICAgICAgICAgICAgICAwICYmXG4gICAgICAgICAgICAgICAgICAgIGNhcmQuYW5zd2VyLmxlbmd0aCA+XG4gICAgICAgICAgICAgICAgICAgICAgICAwXG4gICAgICAgICAgICApO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBleGlzdGluZyBRdWVzdGlvbjo6QW5zd2VyIGNhcmRzIGZyb21cbiAgICAgKiB0aGUgdGV4dCBzZW50IHRvIE9sbGFtYS5cbiAgICAgKi9cbiAgICBwcml2YXRlIHJlbW92ZUV4aXN0aW5nQ2FyZHMoXG4gICAgICAgIG5vdGU6IHN0cmluZ1xuICAgICk6IHN0cmluZyB7XG5cbiAgICAgICAgcmV0dXJuIG5vdGVcbiAgICAgICAgICAgIC5zcGxpdChcIlxcblwiKVxuICAgICAgICAgICAgLmZpbHRlcihsaW5lID0+IHtcblxuICAgICAgICAgICAgICAgIGNvbnN0IHRyaW1tZWQgPVxuICAgICAgICAgICAgICAgICAgICBsaW5lLnRyaW0oKTtcblxuICAgICAgICAgICAgICAgIC8qXG4gICAgICAgICAgICAgICAgICogRXhpc3RpbmcgU3BhY2VkIFJlcGV0aXRpb24gY2FyZC5cbiAgICAgICAgICAgICAgICAgKi9cbiAgICAgICAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAgICAgICAgIC9eLio/OjooPyE6KS4qJC8udGVzdChcbiAgICAgICAgICAgICAgICAgICAgICAgIHRyaW1tZWRcbiAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLypcbiAgICAgICAgICAgICAgICAgKiBEb24ndCBzZW5kIHRoZSBnZW5lcmF0ZWQtY2FyZFxuICAgICAgICAgICAgICAgICAqIHNlY3Rpb24gdG8gT2xsYW1hLlxuICAgICAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgICAgICAgdHJpbW1lZCA9PT1cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5zZXR0aW5ncy5oZWFkaW5nXG4gICAgICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAuam9pbihcIlxcblwiKVxuICAgICAgICAgICAgLnRyaW0oKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFeHRyYWN0IGV4aXN0aW5nIFNwYWNlZCBSZXBldGl0aW9uIGNhcmRzLlxuICAgICAqL1xuICAgIHByaXZhdGUgZXh0cmFjdENhcmRzKFxuICAgICAgICBub3RlOiBzdHJpbmdcbiAgICApOiBDYXJkW10ge1xuXG4gICAgICAgIGNvbnN0IGNhcmRzOiBDYXJkW10gPSBbXTtcblxuICAgICAgICBmb3IgKFxuICAgICAgICAgICAgY29uc3QgbGluZVxuICAgICAgICAgICAgb2Ygbm90ZS5zcGxpdChcIlxcblwiKVxuICAgICAgICApIHtcblxuICAgICAgICAgICAgY29uc3QgbWF0Y2ggPVxuICAgICAgICAgICAgICAgIGxpbmVcbiAgICAgICAgICAgICAgICAgICAgLnRyaW0oKVxuICAgICAgICAgICAgICAgICAgICAubWF0Y2goXG4gICAgICAgICAgICAgICAgICAgICAgICAvXiguKj8pOjooPyE6KSguKikkL1xuICAgICAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAgICAgbWF0Y2ggJiZcbiAgICAgICAgICAgICAgICBtYXRjaFsxXS50cmltKCkgJiZcbiAgICAgICAgICAgICAgICBtYXRjaFsyXS50cmltKClcbiAgICAgICAgICAgICkge1xuXG4gICAgICAgICAgICAgICAgY2FyZHMucHVzaCh7XG4gICAgICAgICAgICAgICAgICAgIHF1ZXN0aW9uOlxuICAgICAgICAgICAgICAgICAgICAgICAgbWF0Y2hbMV0udHJpbSgpLFxuXG4gICAgICAgICAgICAgICAgICAgIGFuc3dlcjpcbiAgICAgICAgICAgICAgICAgICAgICAgIG1hdGNoWzJdLnRyaW0oKSxcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjYXJkcztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBOb3JtYWxpemUgdGV4dCBiZWZvcmUgY29tcGFyaW5nIHF1ZXN0aW9ucy5cbiAgICAgKi9cbiAgICBwcml2YXRlIG5vcm1hbGl6ZShcbiAgICAgICAgdGV4dDogc3RyaW5nXG4gICAgKTogc3RyaW5nIHtcblxuICAgICAgICByZXR1cm4gdGV4dFxuICAgICAgICAgICAgLnRvTG93ZXJDYXNlKClcbiAgICAgICAgICAgIC5yZXBsYWNlKFxuICAgICAgICAgICAgICAgIC9bYCpffl0vZyxcbiAgICAgICAgICAgICAgICBcIlwiXG4gICAgICAgICAgICApXG4gICAgICAgICAgICAucmVwbGFjZShcbiAgICAgICAgICAgICAgICAvW15cXHB7TH1cXHB7Tn1cXHNdL2d1LFxuICAgICAgICAgICAgICAgIFwiIFwiXG4gICAgICAgICAgICApXG4gICAgICAgICAgICAucmVwbGFjZShcbiAgICAgICAgICAgICAgICAvXFxzKy9nLFxuICAgICAgICAgICAgICAgIFwiIFwiXG4gICAgICAgICAgICApXG4gICAgICAgICAgICAudHJpbSgpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIERldGVjdCBkdXBsaWNhdGUgb3IgbmVhci1kdXBsaWNhdGUgcXVlc3Rpb25zLlxuICAgICAqL1xuICAgIHByaXZhdGUgaXNEdXBsaWNhdGUoXG4gICAgICAgIGE6IENhcmQsXG4gICAgICAgIGI6IENhcmRcbiAgICApOiBib29sZWFuIHtcblxuICAgICAgICBjb25zdCB4ID1cbiAgICAgICAgICAgIHRoaXMubm9ybWFsaXplKFxuICAgICAgICAgICAgICAgIGEucXVlc3Rpb25cbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgY29uc3QgeSA9XG4gICAgICAgICAgICB0aGlzLm5vcm1hbGl6ZShcbiAgICAgICAgICAgICAgICBiLnF1ZXN0aW9uXG4gICAgICAgICAgICApO1xuXG4gICAgICAgIGlmICh4ID09PSB5KSB7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qXG4gICAgICAgICAqIENhdGNoIGNhc2VzIHdoZXJlIG9uZSBxdWVzdGlvbiBjb250YWluc1xuICAgICAgICAgKiB0aGUgb3RoZXIgd2l0aCBvbmx5IGEgc21hbGwgd29yZGluZyBjaGFuZ2UuXG4gICAgICAgICAqL1xuICAgICAgICBjb25zdCBzaG9ydGVyID1cbiAgICAgICAgICAgIHgubGVuZ3RoIDwgeS5sZW5ndGhcbiAgICAgICAgICAgICAgICA/IHhcbiAgICAgICAgICAgICAgICA6IHk7XG5cbiAgICAgICAgY29uc3QgbG9uZ2VyID1cbiAgICAgICAgICAgIHgubGVuZ3RoIDwgeS5sZW5ndGhcbiAgICAgICAgICAgICAgICA/IHlcbiAgICAgICAgICAgICAgICA6IHg7XG5cbiAgICAgICAgaWYgKFxuICAgICAgICAgICAgc2hvcnRlci5sZW5ndGggPiAwICYmXG4gICAgICAgICAgICBsb25nZXIuaW5jbHVkZXMoc2hvcnRlcikgJiZcbiAgICAgICAgICAgIHNob3J0ZXIubGVuZ3RoIC9cbiAgICAgICAgICAgICAgICBsb25nZXIubGVuZ3RoID49IDAuOFxuICAgICAgICApIHtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgLypcbiAgICAgICAgICogTGV2ZW5zaHRlaW4gc2ltaWxhcml0eS5cbiAgICAgICAgICovXG4gICAgICAgIHJldHVybiAoXG4gICAgICAgICAgICB0aGlzLnNpbWlsYXJpdHkoXG4gICAgICAgICAgICAgICAgeCxcbiAgICAgICAgICAgICAgICB5XG4gICAgICAgICAgICApID49IDAuODhcbiAgICAgICAgKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDYWxjdWxhdGUgbm9ybWFsaXplZCBMZXZlbnNodGVpbiBzaW1pbGFyaXR5LlxuICAgICAqL1xuICAgIHByaXZhdGUgc2ltaWxhcml0eShcbiAgICAgICAgYTogc3RyaW5nLFxuICAgICAgICBiOiBzdHJpbmdcbiAgICApOiBudW1iZXIge1xuXG4gICAgICAgIGlmICghYSB8fCAhYikge1xuICAgICAgICAgICAgcmV0dXJuIDA7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBsb25nZXIgPVxuICAgICAgICAgICAgYS5sZW5ndGggPj0gYi5sZW5ndGhcbiAgICAgICAgICAgICAgICA/IGFcbiAgICAgICAgICAgICAgICA6IGI7XG5cbiAgICAgICAgY29uc3Qgc2hvcnRlciA9XG4gICAgICAgICAgICBhLmxlbmd0aCA+PSBiLmxlbmd0aFxuICAgICAgICAgICAgICAgID8gYlxuICAgICAgICAgICAgICAgIDogYTtcblxuICAgICAgICBjb25zdCBkaXN0YW5jZSA9XG4gICAgICAgICAgICB0aGlzLmxldmVuc2h0ZWluKFxuICAgICAgICAgICAgICAgIGEsXG4gICAgICAgICAgICAgICAgYlxuICAgICAgICAgICAgKTtcblxuICAgICAgICByZXR1cm4gKFxuICAgICAgICAgICAgMSAtXG4gICAgICAgICAgICBkaXN0YW5jZSAvXG4gICAgICAgICAgICAgICAgbG9uZ2VyLmxlbmd0aFxuICAgICAgICApO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIExldmVuc2h0ZWluIGVkaXQgZGlzdGFuY2UuXG4gICAgICovXG4gICAgcHJpdmF0ZSBsZXZlbnNodGVpbihcbiAgICAgICAgYTogc3RyaW5nLFxuICAgICAgICBiOiBzdHJpbmdcbiAgICApOiBudW1iZXIge1xuXG4gICAgICAgIGNvbnN0IHByZXZpb3VzID1cbiAgICAgICAgICAgIEFycmF5LmZyb20oXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICBsZW5ndGg6XG4gICAgICAgICAgICAgICAgICAgICAgICBiLmxlbmd0aCArIDEsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAoXywgaSkgPT4gaVxuICAgICAgICAgICAgKTtcblxuICAgICAgICBmb3IgKFxuICAgICAgICAgICAgbGV0IGkgPSAxO1xuICAgICAgICAgICAgaSA8PSBhLmxlbmd0aDtcbiAgICAgICAgICAgIGkrK1xuICAgICAgICApIHtcblxuICAgICAgICAgICAgY29uc3QgY3VycmVudCA9XG4gICAgICAgICAgICAgICAgW2ldO1xuXG4gICAgICAgICAgICBmb3IgKFxuICAgICAgICAgICAgICAgIGxldCBqID0gMTtcbiAgICAgICAgICAgICAgICBqIDw9IGIubGVuZ3RoO1xuICAgICAgICAgICAgICAgIGorK1xuICAgICAgICAgICAgKSB7XG5cbiAgICAgICAgICAgICAgICBjdXJyZW50W2pdID1cbiAgICAgICAgICAgICAgICAgICAgTWF0aC5taW4oXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGN1cnJlbnRbaiAtIDFdICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAxLFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBwcmV2aW91c1tqXSArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgMSxcblxuICAgICAgICAgICAgICAgICAgICAgICAgcHJldmlvdXNbaiAtIDFdICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFbaSAtIDFdID09PVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBiW2ogLSAxXVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPyAwXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA6IDFcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZvciAoXG4gICAgICAgICAgICAgICAgbGV0IGogPSAwO1xuICAgICAgICAgICAgICAgIGogPD0gYi5sZW5ndGg7XG4gICAgICAgICAgICAgICAgaisrXG4gICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgICBwcmV2aW91c1tqXSA9XG4gICAgICAgICAgICAgICAgICAgIGN1cnJlbnRbal07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcHJldmlvdXNbXG4gICAgICAgICAgICBiLmxlbmd0aFxuICAgICAgICBdO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENoZWNrIHdoZXRoZXIgdGhlIG5vdGUgY29udGFpbnMgYSB0YWcuXG4gICAgICovXG4gICAgcHJpdmF0ZSBoYXNUYWcoXG4gICAgICAgIG5vdGU6IHN0cmluZyxcbiAgICAgICAgdGFnOiBzdHJpbmdcbiAgICApOiBib29sZWFuIHtcblxuICAgICAgICBjb25zdCBlc2NhcGVkID1cbiAgICAgICAgICAgIHRhZy5yZXBsYWNlKFxuICAgICAgICAgICAgICAgIC9bLiorP14ke30oKXxbXFxdXFxcXF0vZyxcbiAgICAgICAgICAgICAgICBcIlxcXFwkJlwiXG4gICAgICAgICAgICApO1xuXG4gICAgICAgIHJldHVybiBuZXcgUmVnRXhwKFxuICAgICAgICAgICAgYChefFxcXFxzKSR7ZXNjYXBlZH0oPz1cXFxcc3wkKWAsXG4gICAgICAgICAgICBcIm1cIlxuICAgICAgICApLnRlc3Qobm90ZSk7XG4gICAgfVxufVxuXG5jbGFzcyBTZXR0aW5nc1RhYlxuICAgIGV4dGVuZHMgUGx1Z2luU2V0dGluZ1RhYiB7XG5cbiAgICBjb25zdHJ1Y3RvcihcbiAgICAgICAgYXBwOiBBcHAsXG4gICAgICAgIHByaXZhdGUgcGx1Z2luOlxuICAgICAgICAgICAgT2xsYW1hQXV0b0ZsYXNoY2FyZHNcbiAgICApIHtcbiAgICAgICAgc3VwZXIoXG4gICAgICAgICAgICBhcHAsXG4gICAgICAgICAgICBwbHVnaW5cbiAgICAgICAgKTtcbiAgICB9XG5cbiAgICBkaXNwbGF5KCkge1xuXG4gICAgICAgIGNvbnN0IGVsID1cbiAgICAgICAgICAgIHRoaXMuY29udGFpbmVyRWw7XG5cbiAgICAgICAgZWwuZW1wdHkoKTtcblxuICAgICAgICBlbC5jcmVhdGVFbChcbiAgICAgICAgICAgIFwiaDJcIixcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICB0ZXh0OlxuICAgICAgICAgICAgICAgICAgICBcIk9sbGFtYSBBdXRvIEZsYXNoY2FyZHNcIlxuICAgICAgICAgICAgfVxuICAgICAgICApO1xuXG4gICAgICAgIG5ldyBTZXR0aW5nKGVsKVxuICAgICAgICAgICAgLnNldE5hbWUoXG4gICAgICAgICAgICAgICAgXCJPbGxhbWEgZW5kcG9pbnRcIlxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgLnNldERlc2MoXG4gICAgICAgICAgICAgICAgXCJEZWZhdWx0OiBodHRwOi8vMTI3LjAuMC4xOjExNDM0XCJcbiAgICAgICAgICAgIClcbiAgICAgICAgICAgIC5hZGRUZXh0KHRleHQgPT5cbiAgICAgICAgICAgICAgICB0ZXh0XG4gICAgICAgICAgICAgICAgICAgIC5zZXRWYWx1ZShcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLnNldHRpbmdzXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLmVuZHBvaW50XG4gICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICAgICAgLm9uQ2hhbmdlKFxuICAgICAgICAgICAgICAgICAgICAgICAgYXN5bmMgdmFsdWUgPT4ge1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5wbHVnaW5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLnNldHRpbmdzXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC5lbmRwb2ludCA9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlLnRyaW0oKSB8fFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBERUZBVUxUX1NFVFRJTkdTXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuZW5kcG9pbnQ7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgbmV3IFNldHRpbmcoZWwpXG4gICAgICAgICAgICAuc2V0TmFtZShcbiAgICAgICAgICAgICAgICBcIk1vZGVsXCJcbiAgICAgICAgICAgIClcbiAgICAgICAgICAgIC5zZXREZXNjKFxuICAgICAgICAgICAgICAgIFwiQW55IG1vZGVsIGluc3RhbGxlZCBpbiBPbGxhbWEuXCJcbiAgICAgICAgICAgIClcbiAgICAgICAgICAgIC5hZGRUZXh0KHRleHQgPT5cbiAgICAgICAgICAgICAgICB0ZXh0XG4gICAgICAgICAgICAgICAgICAgIC5zZXRWYWx1ZShcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLnNldHRpbmdzXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLm1vZGVsXG4gICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICAgICAgLm9uQ2hhbmdlKFxuICAgICAgICAgICAgICAgICAgICAgICAgYXN5bmMgdmFsdWUgPT4ge1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5wbHVnaW5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLnNldHRpbmdzXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC5tb2RlbCA9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlLnRyaW0oKSB8fFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBERUZBVUxUX1NFVFRJTkdTXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAubW9kZWw7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgbmV3IFNldHRpbmcoZWwpXG4gICAgICAgICAgICAuc2V0TmFtZShcbiAgICAgICAgICAgICAgICBcIlRlbXBlcmF0dXJlXCJcbiAgICAgICAgICAgIClcbiAgICAgICAgICAgIC5zZXREZXNjKFxuICAgICAgICAgICAgICAgIFwiTG93ZXIgdmFsdWVzIHByb2R1Y2UgbW9yZSBkZXRlcm1pbmlzdGljIGNhcmRzLiAwLjHigJMwLjMgaXMgcmVjb21tZW5kZWQuXCJcbiAgICAgICAgICAgIClcbiAgICAgICAgICAgIC5hZGRUZXh0KHRleHQgPT5cbiAgICAgICAgICAgICAgICB0ZXh0XG4gICAgICAgICAgICAgICAgICAgIC5zZXRWYWx1ZShcbiAgICAgICAgICAgICAgICAgICAgICAgIFN0cmluZyhcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLnBsdWdpblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuc2V0dGluZ3NcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLnRlbXBlcmF0dXJlXG4gICAgICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICAgICAgLm9uQ2hhbmdlKFxuICAgICAgICAgICAgICAgICAgICAgICAgYXN5bmMgdmFsdWUgPT4ge1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgcGFyc2VkID1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgTnVtYmVyLnBhcnNlRmxvYXQoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5wbHVnaW5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLnNldHRpbmdzXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC50ZW1wZXJhdHVyZSA9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIE51bWJlci5pc0Zpbml0ZShcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcnNlZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IE1hdGgubWF4KFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgTWF0aC5taW4oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDEsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcnNlZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogREVGQVVMVF9TRVRUSU5HU1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC50ZW1wZXJhdHVyZTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgKTtcblxuICAgICAgICBuZXcgU2V0dGluZyhlbClcbiAgICAgICAgICAgIC5zZXROYW1lKFxuICAgICAgICAgICAgICAgIFwiRGVjayB0YWdcIlxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgLnNldERlc2MoXG4gICAgICAgICAgICAgICAgXCJUYWcgdXNlZCBmb3IgdGhlIGZsYXNoY2FyZCBkZWNrLlwiXG4gICAgICAgICAgICApXG4gICAgICAgICAgICAuYWRkVGV4dCh0ZXh0ID0+XG4gICAgICAgICAgICAgICAgdGV4dFxuICAgICAgICAgICAgICAgICAgICAuc2V0VmFsdWUoXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLnBsdWdpblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC5zZXR0aW5nc1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC50YWdcbiAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICAgICAub25DaGFuZ2UoXG4gICAgICAgICAgICAgICAgICAgICAgICBhc3luYyB2YWx1ZSA9PiB7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLnBsdWdpblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuc2V0dGluZ3NcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLnRhZyA9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlLnRyaW0oKSB8fFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBERUZBVUxUX1NFVFRJTkdTXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAudGFnO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICApO1xuXG4gICAgICAgIG5ldyBTZXR0aW5nKGVsKVxuICAgICAgICAgICAgLnNldE5hbWUoXG4gICAgICAgICAgICAgICAgXCJTZWN0aW9uIGhlYWRpbmdcIlxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgLnNldERlc2MoXG4gICAgICAgICAgICAgICAgXCJIZWFkaW5nIHVzZWQgZm9yIGdlbmVyYXRlZCBjYXJkcy5cIlxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgLmFkZFRleHQodGV4dCA9PlxuICAgICAgICAgICAgICAgIHRleHRcbiAgICAgICAgICAgICAgICAgICAgLnNldFZhbHVlKFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5wbHVnaW5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuc2V0dGluZ3NcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuaGVhZGluZ1xuICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgICAgIC5vbkNoYW5nZShcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzeW5jIHZhbHVlID0+IHtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMucGx1Z2luXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC5zZXR0aW5nc1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuaGVhZGluZyA9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlLnRyaW0oKSB8fFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBERUZBVUxUX1NFVFRJTkdTXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuaGVhZGluZztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgKTtcblxuICAgICAgICBlbC5jcmVhdGVFbChcbiAgICAgICAgICAgIFwicFwiLFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIHRleHQ6XG4gICAgICAgICAgICAgICAgICAgIFwiVGhlIG51bWJlciBvZiBmbGFzaGNhcmRzIGlzIGF1dG9tYXRpY2FsbHkgY2FsY3VsYXRlZCBmcm9tIG5vdGUgbGVuZ3RoIGFuZCBpbmZvcm1hdGlvbiBkZW5zaXR5LlwiXG4gICAgICAgICAgICB9XG4gICAgICAgICk7XG5cbiAgICAgICAgZWwuY3JlYXRlRWwoXG4gICAgICAgICAgICBcInBcIixcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICB0ZXh0OlxuICAgICAgICAgICAgICAgICAgICBcIkdlbmVyYXRlZCBjYXJkcyB1c2UgUXVlc3Rpb246OkFuc3dlciBzeW50YXggZm9yIGNvbXBhdGliaWxpdHkgd2l0aCB0aGUgU3BhY2VkIFJlcGV0aXRpb24gcGx1Z2luLlwiXG4gICAgICAgICAgICB9XG4gICAgICAgICk7XG4gICAgfVxufVxuIl0sIm5hbWVzIjpbIlBsdWdpbiIsIk5vdGljZSIsIlBsdWdpblNldHRpbmdUYWIiLCJTZXR0aW5nIl0sIm1hcHBpbmdzIjoiOzs7O0FBcUJBLE1BQU0sZ0JBQWdCLEdBQWE7QUFDL0IsSUFBQSxRQUFRLEVBQUUsd0JBQXdCO0FBQ2xDLElBQUEsS0FBSyxFQUFFLFVBQVU7QUFDakIsSUFBQSxXQUFXLEVBQUUsR0FBRztBQUNoQixJQUFBLEdBQUcsRUFBRSxhQUFhO0FBQ2xCLElBQUEsT0FBTyxFQUFFLGtCQUFrQjtDQUM5QjtBQUVhLE1BQU8sb0JBQXFCLFNBQVFBLGVBQU0sQ0FBQTtBQUdwRCxJQUFBLE1BQU0sTUFBTSxHQUFBO0FBQ1IsUUFBQSxJQUFJLENBQUMsUUFBUSxHQUFHLE1BQU0sQ0FBQyxNQUFNLENBQ3pCLEVBQUUsRUFDRixnQkFBZ0IsRUFDaEIsTUFBTSxJQUFJLENBQUMsUUFBUSxFQUFFLENBQ3hCO1FBRUQsSUFBSSxDQUFDLFVBQVUsQ0FBQztBQUNaLFlBQUEsRUFBRSxFQUFFLGtDQUFrQztBQUN0QyxZQUFBLElBQUksRUFBRSx1Q0FBdUM7QUFDN0MsWUFBQSxRQUFRLEVBQUUsTUFBTSxJQUFJLENBQUMsUUFBUSxFQUFFO0FBQ2xDLFNBQUEsQ0FBQztBQUVGLFFBQUEsSUFBSSxDQUFDLGFBQWEsQ0FDZCxJQUFJLFdBQVcsQ0FBQyxJQUFJLENBQUMsR0FBRyxFQUFFLElBQUksQ0FBQyxDQUNsQztJQUNMO0FBRUEsSUFBQSxNQUFNLFlBQVksR0FBQTtRQUNkLE1BQU0sSUFBSSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDO0lBQ3RDO0FBRUE7O0FBRUc7QUFDSyxJQUFBLE1BQU0sUUFBUSxHQUFBO1FBQ2xCLE1BQU0sSUFBSSxHQUNOLElBQUksQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLGFBQWEsRUFBRTtRQUV0QyxJQUFJLENBQUMsSUFBSSxFQUFFO0FB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
