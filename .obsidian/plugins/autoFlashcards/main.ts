import {
    App,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
} from "obsidian";

interface Settings {
    endpoint: string;
    model: string;
    temperature: number;
    tag: string;
    heading: string;
}

interface Card {
    question: string;
    answer: string;
}

const DEFAULT_SETTINGS: Settings = {
    endpoint: "http://127.0.0.1:11434",
    model: "llama3.2",
    temperature: 0.2,
    tag: "#flashcards",
    heading: "## AI Flashcards",
};

export default class OllamaAutoFlashcards extends Plugin {
    settings!: Settings;

    async onload() {
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            await this.loadData()
        );

        this.addCommand({
            id: "generate-flashcards-current-note",
            name: "Generate flashcards from current note",
            callback: () => this.generate(),
        });

        this.addSettingTab(
            new SettingsTab(this.app, this)
        );
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    /**
     * Main generation function.
     */
    private async generate() {
        const file =
            this.app.workspace.getActiveFile();

        if (!file) {
            new Notice("No active note.");
            return;
        }

        if (file.extension !== "md") {
            new Notice(
                "The active file is not a Markdown note."
            );
            return;
        }

        const note =
            await this.app.vault.read(file);

        if (!note.trim()) {
            new Notice(
                "The current note is empty."
            );
            return;
        }

        /*
         * Calculate how many cards should be generated
         * before contacting Ollama.
         */
        const cardCount =
            this.calculateCardCount(note);

        new Notice(
            `Generating approximately ${cardCount} flashcards...`
        );

        try {
            const generated =
                await this.generateCards(
                    note,
                    cardCount
                );

            if (generated.length === 0) {
                new Notice(
                    "Ollama returned no usable flashcards."
                );
                return;
            }

            /*
             * Extract cards that already exist in the note.
             */
            const existing =
                this.extractCards(note);

            /*
             * Remove duplicates both against the note
             * and against other cards generated in this
             * same request.
             */
            const unique: Card[] = [];

            for (const card of generated) {
                const duplicateExisting =
                    existing.some(
                        old =>
                            this.isDuplicate(
                                card,
                                old
                            )
                    );

                if (duplicateExisting) {
                    continue;
                }

                const duplicateGenerated =
                    unique.some(
                        old =>
                            this.isDuplicate(
                                card,
                                old
                            )
                    );

                if (duplicateGenerated) {
                    continue;
                }

                unique.push(card);
            }

            if (unique.length === 0) {
                new Notice(
                    "No new flashcards were generated."
                );
                return;
            }

            /*
             * Append the cards to the note.
             */
            let output =
                note.trimEnd();

            /*
             * Add the deck tag if it doesn't already
             * exist.
             */
            if (
                !this.hasTag(
                    output,
                    this.settings.tag
                )
            ) {
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
                const question =
                    card.question
                        .replace(/::/g, ":")
                        .replace(/\n+/g, " ")
                        .trim();

                const answer =
                    card.answer
                        .replace(/::/g, ":")
                        .replace(/\n+/g, " ")
                        .trim();

                output +=
                    `${question}::${answer}\n`;
            }

            await this.app.vault.modify(
                file,
                output
            );

            new Notice(
                `Added ${unique.length} new flashcard${
                    unique.length === 1
                        ? ""
                        : "s"
                }.`
            );

        } catch (error) {
            console.error(
                "Ollama Auto Flashcards:",
                error
            );

            const message =
                error instanceof Error
                    ? error.message
                    : String(error);

            new Notice(
                `Flashcard generation failed: ${message}`
            );
        }
    }

    /**
     * Determine an appropriate number of flashcards
     * from the note's length and information density.
     */
    private calculateCardCount(
        note: string
    ): number {

        /*
         * Remove existing flashcards and irrelevant
         * metadata before calculating density.
         */
        const cleanNote =
            note
                .split("\n")
                .filter(line => {

                    const trimmed =
                        line.trim();

                    if (!trimmed) {
                        return false;
                    }

                    /*
                     * Ignore code fences.
                     */
                    if (
                        trimmed.startsWith("```")
                    ) {
                        return false;
                    }

                    /*
                     * Ignore the flashcard tag.
                     */
                    if (
                        trimmed
                            .startsWith(
                                "#flashcards"
                            )
                    ) {
                        return false;
                    }

                    /*
                     * Ignore existing
                     * Question::Answer cards.
                     */
                    if (
                        /^.*?::(?!:).*$/.test(
                            trimmed
                        )
                    ) {
                        return false;
                    }

                    return true;
                })
                .join("\n");

        const words =
            cleanNote
                .split(/\s+/)
                .filter(Boolean);

        const wordCount =
            words.length;

        /*
         * Empty/very small notes.
         */
        if (wordCount === 0) {
            return 1;
        }

        /*
         * Analyze structure.
         */
        const lines =
            cleanNote.split("\n");

        /*
         * Markdown headings.
         */
        const headings =
            lines.filter(line =>
                /^#{1,6}\s+/.test(
                    line.trim()
                )
            ).length;

        /*
         * Bullet lists.
         */
        const listItems =
            lines.filter(line =>
                /^[-*+]\s+/.test(
                    line.trim()
                ) ||
                /^\d+[.)]\s+/.test(
                    line.trim()
                )
            ).length;

        /*
         * Definition-like language.
         */
        const definitionIndicators =
            (
                cleanNote.match(
                    /\b(is|are|means|refers to|defined as|consists of|known as|called)\b/gi
                ) ?? []
            ).length;

        /*
         * Equations/formulas.
         */
        const formulas =
            (
                cleanNote.match(
                    /[=→⇒∑∫√±×÷^]|\b[A-Za-z]\s*=\s*[A-Za-z0-9]/g
                ) ?? []
            ).length;

        /*
         * Base estimate:
         *
         * One card for roughly every 60 words.
         */
        let count =
            wordCount / 60;

        /*
         * Increase card count when the note has
         * many independently testable pieces of
         * information.
         */
        const densityBonus =
            headings * 0.5 +
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

        return Math.max(
            1,
            Math.round(count)
        );
    }

    /**
     * Generate flashcards using Ollama.
     */
    private async generateCards(
        note: string,
        cardCount: number
    ): Promise<Card[]> {

        /*
         * Remove existing flashcards before sending
         * the note to Ollama.
         *
         * This reduces context size and prevents the
         * model from wasting tokens looking at cards
         * that already exist.
         */
        const studyContent =
            this.removeExistingCards(note);

        const endpoint =
            this.settings.endpoint
                .replace(/\/+$/, "");

        const response =
            await fetch(
                `${endpoint}/api/chat`,
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json",
                    },

                    body: JSON.stringify({

                        model:
                            this.settings.model,

                        stream: false,

                        options: {
                            temperature:
                                this.settings.temperature,
                        },

                        messages: [

                            {
                                role: "system",

                                content:
                                    `
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

                                content:
                                    `
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
                }
            );

        if (!response.ok) {
            const body =
                await response.text();

            throw new Error(
                `Ollama returned HTTP ${response.status}: ${body.slice(
                    0,
                    200
                )}`
            );
        }

        const data =
            await response.json() as {
                message?: {
                    content?: string;
                };
            };

        let text =
            data.message?.content?.trim() ??
            "";

        if (!text) {
            throw new Error(
                "Ollama returned an empty response."
            );
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
                .replace(
                    /^```json\s*/i,
                    ""
                )
                .replace(
                    /^```\s*/i,
                    ""
                )
                .replace(
                    /\s*```$/i,
                    ""
                )
                .trim();

        /*
         * If the model added text before/after JSON,
         * try to extract the JSON object.
         */
        const start =
            text.indexOf("{");

        const end =
            text.lastIndexOf("}");

        if (
            start >= 0 &&
            end > start
        ) {
            text =
                text.slice(
                    start,
                    end + 1
                );
        }

        let parsed: {
            cards?: unknown;
        };

        try {
            parsed =
                JSON.parse(text);
        } catch {
            throw new Error(
                "Ollama returned invalid JSON."
            );
        }

        if (
            !Array.isArray(
                parsed.cards
            )
        ) {
            throw new Error(
                "Ollama did not return a cards array."
            );
        }

        return parsed.cards
            .filter(
                (
                    item
                ): item is Card => {

                    if (
                        !item ||
                        typeof item !==
                            "object"
                    ) {
                        return false;
                    }

                    const candidate =
                        item as Partial<Card>;

                    return (
                        typeof candidate.question ===
                            "string" &&
                        typeof candidate.answer ===
                            "string"
                    );
                }
            )
            .map(card => ({
                question:
                    card.question
                        .trim(),

                answer:
                    card.answer
                        .trim(),
            }))
            .filter(
                card =>
                    card.question.length >
                        0 &&
                    card.answer.length >
                        0
            );
    }

    /**
     * Remove existing Question::Answer cards from
     * the text sent to Ollama.
     */
    private removeExistingCards(
        note: string
    ): string {

        return note
            .split("\n")
            .filter(line => {

                const trimmed =
                    line.trim();

                /*
                 * Existing Spaced Repetition card.
                 */
                if (
                    /^.*?::(?!:).*$/.test(
                        trimmed
                    )
                ) {
                    return false;
                }

                /*
                 * Don't send the generated-card
                 * section to Ollama.
                 */
                if (
                    trimmed ===
                    this.settings.heading
                ) {
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
    private extractCards(
        note: string
    ): Card[] {

        const cards: Card[] = [];

        for (
            const line
            of note.split("\n")
        ) {

            const match =
                line
                    .trim()
                    .match(
                        /^(.*?)::(?!:)(.*)$/
                    );

            if (
                match &&
                match[1].trim() &&
                match[2].trim()
            ) {

                cards.push({
                    question:
                        match[1].trim(),

                    answer:
                        match[2].trim(),
                });
            }
        }

        return cards;
    }

    /**
     * Normalize text before comparing questions.
     */
    private normalize(
        text: string
    ): string {

        return text
            .toLowerCase()
            .replace(
                /[`*_~]/g,
                ""
            )
            .replace(
                /[^\p{L}\p{N}\s]/gu,
                " "
            )
            .replace(
                /\s+/g,
                " "
            )
            .trim();
    }

    /**
     * Detect duplicate or near-duplicate questions.
     */
    private isDuplicate(
        a: Card,
        b: Card
    ): boolean {

        const x =
            this.normalize(
                a.question
            );

        const y =
            this.normalize(
                b.question
            );

        if (x === y) {
            return true;
        }

        /*
         * Catch cases where one question contains
         * the other with only a small wording change.
         */
        const shorter =
            x.length < y.length
                ? x
                : y;

        const longer =
            x.length < y.length
                ? y
                : x;

        if (
            shorter.length > 0 &&
            longer.includes(shorter) &&
            shorter.length /
                longer.length >= 0.8
        ) {
            return true;
        }

        /*
         * Levenshtein similarity.
         */
        return (
            this.similarity(
                x,
                y
            ) >= 0.88
        );
    }

    /**
     * Calculate normalized Levenshtein similarity.
     */
    private similarity(
        a: string,
        b: string
    ): number {

        if (!a || !b) {
            return 0;
        }

        const longer =
            a.length >= b.length
                ? a
                : b;

        const shorter =
            a.length >= b.length
                ? b
                : a;

        const distance =
            this.levenshtein(
                a,
                b
            );

        return (
            1 -
            distance /
                longer.length
        );
    }

    /**
     * Levenshtein edit distance.
     */
    private levenshtein(
        a: string,
        b: string
    ): number {

        const previous =
            Array.from(
                {
                    length:
                        b.length + 1,
                },
                (_, i) => i
            );

        for (
            let i = 1;
            i <= a.length;
            i++
        ) {

            const current =
                [i];

            for (
                let j = 1;
                j <= b.length;
                j++
            ) {

                current[j] =
                    Math.min(

                        current[j - 1] +
                            1,

                        previous[j] +
                            1,

                        previous[j - 1] +
                            (
                                a[i - 1] ===
                                b[j - 1]
                                    ? 0
                                    : 1
                            )
                    );
            }

            for (
                let j = 0;
                j <= b.length;
                j++
            ) {
                previous[j] =
                    current[j];
            }
        }

        return previous[
            b.length
        ];
    }

    /**
     * Check whether the note contains a tag.
     */
    private hasTag(
        note: string,
        tag: string
    ): boolean {

        const escaped =
            tag.replace(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&"
            );

        return new RegExp(
            `(^|\\s)${escaped}(?=\\s|$)`,
            "m"
        ).test(note);
    }
}

class SettingsTab
    extends PluginSettingTab {

    constructor(
        app: App,
        private plugin:
            OllamaAutoFlashcards
    ) {
        super(
            app,
            plugin
        );
    }

    display() {

        const el =
            this.containerEl;

        el.empty();

        el.createEl(
            "h2",
            {
                text:
                    "Ollama Auto Flashcards"
            }
        );

        new Setting(el)
            .setName(
                "Ollama endpoint"
            )
            .setDesc(
                "Default: http://127.0.0.1:11434"
            )
            .addText(text =>
                text
                    .setValue(
                        this.plugin
                            .settings
                            .endpoint
                    )
                    .onChange(
                        async value => {

                            this.plugin
                                .settings
                                .endpoint =
                                value.trim() ||
                                DEFAULT_SETTINGS
                                    .endpoint;

                            await this.plugin
                                .saveSettings();
                        }
                    )
            );

        new Setting(el)
            .setName(
                "Model"
            )
            .setDesc(
                "Any model installed in Ollama."
            )
            .addText(text =>
                text
                    .setValue(
                        this.plugin
                            .settings
                            .model
                    )
                    .onChange(
                        async value => {

                            this.plugin
                                .settings
                                .model =
                                value.trim() ||
                                DEFAULT_SETTINGS
                                    .model;

                            await this.plugin
                                .saveSettings();
                        }
                    )
            );

        new Setting(el)
            .setName(
                "Temperature"
            )
            .setDesc(
                "Lower values produce more deterministic cards. 0.1–0.3 is recommended."
            )
            .addText(text =>
                text
                    .setValue(
                        String(
                            this.plugin
                                .settings
                                .temperature
                        )
                    )
                    .onChange(
                        async value => {

                            const parsed =
                                Number.parseFloat(
                                    value
                                );

                            this.plugin
                                .settings
                                .temperature =
                                Number.isFinite(
                                    parsed
                                )
                                    ? Math.max(
                                        0,
                                        Math.min(
                                            1,
                                            parsed
                                        )
                                    )
                                    : DEFAULT_SETTINGS
                                        .temperature;

                            await this.plugin
                                .saveSettings();
                        }
                    )
            );

        new Setting(el)
            .setName(
                "Deck tag"
            )
            .setDesc(
                "Tag used for the flashcard deck."
            )
            .addText(text =>
                text
                    .setValue(
                        this.plugin
                            .settings
                            .tag
                    )
                    .onChange(
                        async value => {

                            this.plugin
                                .settings
                                .tag =
                                value.trim() ||
                                DEFAULT_SETTINGS
                                    .tag;

                            await this.plugin
                                .saveSettings();
                        }
                    )
            );

        new Setting(el)
            .setName(
                "Section heading"
            )
            .setDesc(
                "Heading used for generated cards."
            )
            .addText(text =>
                text
                    .setValue(
                        this.plugin
                            .settings
                            .heading
                    )
                    .onChange(
                        async value => {

                            this.plugin
                                .settings
                                .heading =
                                value.trim() ||
                                DEFAULT_SETTINGS
                                    .heading;

                            await this.plugin
                                .saveSettings();
                        }
                    )
            );

        el.createEl(
            "p",
            {
                text:
                    "The number of flashcards is automatically calculated from note length and information density."
            }
        );

        el.createEl(
            "p",
            {
                text:
                    "Generated cards use Question::Answer syntax for compatibility with the Spaced Repetition plugin."
            }
        );
    }
}
