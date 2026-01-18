export class DropZone {
    private element: HTMLElement;
    private onFileCallback: (file: File) => void;

    constructor(elementId: string, onFile: (file: File) => void) {
        const el = document.getElementById(elementId);
        if (!el) {
            throw new Error(`Element with id ${elementId} not found`);
        }
        this.element = el;
        this.onFileCallback = onFile;

        this.initEvents();
    }

    private initEvents(): void {
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            this.element.addEventListener(eventName, this.preventDefaults, false);
        });

        ['dragenter', 'dragover'].forEach(eventName => {
            this.element.addEventListener(eventName, this.highlight, false);
        });

        ['dragleave', 'drop'].forEach(eventName => {
            this.element.addEventListener(eventName, this.unhighlight, false);
        });

        this.element.addEventListener('drop', this.handleDrop, false);
    }

    private preventDefaults = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
    };

    private highlight = () => {
        this.element.classList.add('highlight');
        this.element.style.borderColor = '#00ff00';
        this.element.style.backgroundColor = 'rgba(0, 255, 0, 0.1)';
    };

    private unhighlight = () => {
        this.element.classList.remove('highlight');
        this.element.style.borderColor = '#333'; // Reset to default (should read from CSS really)
        this.element.style.backgroundColor = '';
    };

    private handleDrop = (e: DragEvent) => {
        const dt = e.dataTransfer;
        if (dt && dt.files && dt.files.length > 0) {
            this.onFileCallback(dt.files[0]);
        }
    };
}
