<div align="center">
  <img src="ui/img/alignfix.png" alt="AlignFix Logo" width="200"/>
  
  # AlignFix

  [![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
  [![WebAssembly](https://img.shields.io/badge/WebAssembly-654FF0?logo=webassembly&logoColor=white)](https://webassembly.org/)
  [![Python](https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=white)](https://www.python.org/)
  [![Bootstrap](https://img.shields.io/badge/Bootstrap-5-7952B3?logo=bootstrap&logoColor=white)](https://getbootstrap.com/)
</div>

**AlignFix** is a browser-based tool for analyzing and refining parallel text corpora. Built entirely with WebAssembly (WASM), it provides desktop-class performance for word alignment, phrase extraction, and quality assessment—all running 100% locally in your browser with complete privacy.

## 🌟 Key Features

### 🔗 Word Alignment
- **FastAlign** implementation compiled to WebAssembly
- Bidirectional alignment (forward + reverse)
- Multiple symmetrization strategies (intersection, union, grow-diag-final)
- Interactive visualization of alignment points
- Quality scoring with confidence, agreement, and coverage metrics

### 📊 Quality Analysis
- Comprehensive alignment quality metrics
- Interactive histograms and distributions
- Multi-criteria filtering (confidence, agreement, asymmetry)
- Real-time statistics and visualizations
- Export quality reports to CSV

### 🔤 Phrase Extraction
- Parallel phrase pair extraction from aligned corpora
- Multi-threaded processing using Web Workers
- Configurable phrase length (1-7 words)
- Frequency filtering and quality thresholds
- Batch processing for large corpora (1M+ sentences)

### 📁 Project Management
- SQLite database stored in browser (IndexedDB via Pyodide)
- Multiple project support with isolation
- Persistent storage across sessions
- Import/export projects and phrase tables
- Efficient memory management for large datasets

### 🔧 Error Correction & Refinement
- Manual alignment correction
- Fix propagation across corpus
- Sentence pair filtering
- Phrase table cleaning
- Iterative refinement workflow

## 🚀 Quick Start

### Prerequisites
- Modern web browser (Chrome 90+, Edge 90+, Firefox 88+, or Safari 14+)
- 4GB RAM minimum (8GB+ recommended for large corpora)
- Multi-core CPU recommended for parallel processing

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/alignfix/alignfix.git
   cd alignfix
   ```

2. **Start the development server:**
   ```bash
   python serve.py
   ```
   
   This starts a local server at `http://127.0.0.1:8000` with the required CORS headers for WebAssembly and SharedArrayBuffer support.

3. **Open in browser:**
   Navigate to `http://127.0.0.1:8000` in your browser.

### First Project

1. Click **"Start"** to create a new project
2. Upload parallel text files (one sentence per line)
3. Click **"Compute Alignments"** to run FastAlign
4. Analyze quality metrics in the **"Scores"** tab
5. Extract phrase pairs in the **"Project"** tab
6. Export results when complete

## 🏗️ Architecture

### Technology Stack

#### Frontend
- **Vanilla JavaScript** - No framework overhead, direct DOM manipulation
- **Bootstrap 5** - Modern, responsive UI components
- **Chart.js** - Interactive data visualization
- **DataTables** - Efficient table rendering with virtualization
- **Font Awesome** - Rich icon library

#### Backend (WebAssembly)
- **Emscripten** - C++ to WebAssembly compiler
- **FastAlign** - Statistical word alignment (EM algorithm)
- **Pyodide** - Python runtime in browser (for SQLite)
- **Web Workers** - Parallel processing for compute-intensive tasks

#### Data Storage
- **SQLite** (via Pyodide) - Relational database in browser
- **IndexedDB** - Browser-native persistent storage
- **OPFS** (Origin Private File System) - File system access

### Performance Optimizations

- **Multi-threading:** Web Workers for parallel phrase extraction
- **Batch processing:** Chunked processing for memory efficiency
- **Dynamic WASM loading:** Hardware-aware module selection (1/4/8/16 cores)
- **Virtualization:** DataTables Scroller renders only visible rows
- **Debouncing:** Optimized filtering and search
- **Memory profiling:** Track and optimize memory usage

### Directory Structure

```
alignfix-github/
├── index.html              # Main entry point
├── main.js                 # Application initialization
├── router.js               # Client-side routing
├── serve.py                # Development server with CORS headers
├── pyodide.js             # Pyodide initialization
├── compile.sh             # WASM compilation script
├── compile_all_configs.sh # Compile all WASM configurations
├── backend/
│   ├── module-loader.js   # Dynamic WASM module loader
│   ├── c/                 # C++ source and compiled WASM
│   │   ├── phrase_extraction.cc
│   │   ├── text_tokenize.cc
│   │   ├── alignment_score.cc
│   │   └── *.js/*.wasm   # Compiled modules (_p1, _p4, _p8, _p16)
│   ├── fast_align/        # FastAlign implementation
│   │   ├── src/
│   │   └── *.js/*.wasm   # Compiled modules
│   ├── js/                # JavaScript backend modules
│   │   ├── aligner.js    # Word alignment logic
│   │   ├── phrases.js    # Phrase extraction
│   │   ├── scores.js     # Quality scoring
│   │   ├── fixes.js      # Error correction
│   │   ├── projects.js   # Project management
│   │   └── storage.js    # Database interface
│   └── py/                # Python modules (run via Pyodide)
│       ├── alignment.py
│       ├── phrases.py
│       ├── scores.py
│       ├── fixes.py
│       └── db.py
└── ui/                    # UI components
    ├── home.js
    ├── project.js
    ├── scores.js
    ├── stats.js
    ├── history.js
    ├── about.js
    ├── profiler.js
    └── html/
        ├── about.html
        └── about-sidebar.html
```

## 🔨 Building from Source

### Prerequisites
- [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html)
- Python 3.x
- Bash shell

### Compile WebAssembly Modules

The project includes pre-compiled WASM modules, but you can recompile them:

#### Compile all configurations:
```bash
bash compile_all_configs.sh
```

This generates optimized builds for different hardware:
- `_p1`: 1 thread, 2GB memory (minimal)
- `_p4`: 4 threads, 4GB memory (low)
- `_p8`: 8 threads, 8GB memory (medium)
- `_p16`: 16 threads, 16GB memory (high)

#### Compile specific configuration:
```bash
bash compile.sh <THREADS> <MEMORY>

# Examples:
bash compile.sh 1 2GB
bash compile.sh 8 8GB
bash compile.sh 16 16GB
```

The dynamic module loader (`backend/module-loader.js`) automatically selects the optimal configuration based on detected hardware capabilities.

## 📖 Usage Guide

### Word Alignment

1. **Upload Corpus:**
   - Source language file (one sentence per line)
   - Target language file (same number of lines)

2. **Run FastAlign:**
   - Computes bidirectional alignments
   - Applies symmetrization (grow-diag-final recommended)
   - Progress bar shows iteration status

3. **Review Alignments:**
   - Interactive visualization
   - Click sentence pairs to view alignments
   - Quality metrics displayed per pair

### Quality Scoring

AlignFix computes multiple quality metrics:

- **Confidence:** Alignment certainty based on translation probabilities
- **Agreement:** Consistency between forward and reverse alignments
- **Coverage:** Percentage of words aligned
- **Asymmetry:** Difference in coverage between source/target
- **Stability:** Variation in alignment scores
- **NULL Alignment Rate:** Percentage of unaligned words

Filter and export low-quality pairs for manual review or removal.

### Phrase Extraction

1. **Configure Settings:**
   - Max phrase length (1-7 words)
   - Minimum occurrence frequency
   - Quality thresholds

2. **Extract Phrases:**
   - Parallel processing across multiple workers
   - Progress tracking per chunk
   - Automatic deduplication

3. **Review & Export:**
   - Browse extracted phrase pairs
   - Filter by frequency or quality
   - Export to CSV, TMX, or Moses format

### Error Correction

1. **Identify Errors:**
   - Low-quality alignment scores
   - Manual inspection of alignments
   - Inconsistent phrase pairs

2. **Apply Fixes:**
   - Correct misalignments manually
   - Propagate fixes to all occurrences
   - Re-extract affected phrases

3. **Iterative Refinement:**
   - Re-score alignments after fixes
   - Filter improved vs. degraded pairs
   - Repeat until satisfactory quality

## 🔒 Privacy & Security

- **100% Client-Side:** All processing happens in your browser
- **No Server Uploads:** Files never leave your device
- **No Tracking:** No analytics or telemetry
- **Offline Capable:** Works without internet after initial load
- **Local Storage Only:** Data stored in browser IndexedDB

Perfect for confidential documents, proprietary corpora, or sensitive data that cannot be uploaded to external servers.

## 📊 Performance Benchmarks

| Operation | Dataset Size | Time | Configuration |
|-----------|--------------|------|---------------|
| Word Alignment | 100K pairs | ~2-5 min | 8 cores, 8GB |
| Phrase Extraction | 1M pairs | ~5-15 min | 16 cores, 16GB |
| Quality Scoring | 100K pairs | ~30-60 sec | 8 cores |
| Database Query | 1M alignments | <1 sec | Indexed |
| Export CSV | 500K phrases | ~10-30 sec | - |

*Performance depends on hardware (CPU cores, RAM) and browser. Chrome/Edge provide best WebAssembly performance.*

## 🎯 Use Cases

### Machine Translation
Build phrase tables for statistical and neural MT systems. Extract high-quality parallel phrases for training.

### Linguistic Research
Analyze translation patterns, study cross-lingual phenomena, research alignment algorithms for low-resource language pairs.

### Data Quality Assessment
Evaluate parallel corpus quality, identify misalignments, clean noisy data before training translation systems.

### Education & Training
Teach translation concepts, demonstrate alignment algorithms, provide hands-on experience with parallel corpus processing.

## 🛠️ Development

### Project Structure

- **UI Layer:** `ui/` - View components and rendering logic
- **Controller Layer:** `backend/js/` - Business logic and orchestration
- **Data Layer:** `backend/py/` - Database operations via Pyodide
- **Compute Layer:** `backend/c/`, `backend/fast_align/` - WASM modules

### Adding New Features

1. **UI Component:** Add to `ui/` directory
2. **Business Logic:** Add to `backend/js/`
3. **Database Operations:** Add to `backend/py/`
4. **Performance-Critical Code:** Implement in C++ and compile to WASM

### Debugging

- Open browser DevTools (F12)
- Check Console for logs and errors
- Use the built-in progress bar and log viewer
- Enable profiler for memory usage tracking

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **FastAlign** - [Chris Dyer et al.](https://github.com/clab/fast_align)
- **Emscripten** - For making C++ in the browser possible
- **Pyodide** - For Python in WebAssembly
- **Bootstrap** - For the UI framework
- **Chart.js** - For data visualization

## 📞 Support

For questions, issues, or feature requests, please [open an issue](https://github.com/alignfix/alignfix/issues) on GitHub.

---

**Built with ❤️ for the NLP and MT community**
