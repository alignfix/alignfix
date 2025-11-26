#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <pthread.h>
#include <emscripten/emscripten.h>
#include <unordered_set>
#include <string>

#define MAX_LINE_LENGTH 4096
#define MAX_PHRASE_LENGTH 512
#define MAX_TOKENS_PER_LINE 512
#define MAX_ALIGNMENTS_PER_LINE 256
#define MAX_PHRASES_PER_LINE 2048

typedef struct
{
    int src;
    int tgt;
} Alignment;

typedef struct
{
    char *src_phrase;
    char *tgt_phrase;
} Phrase;

// Hash set for fast phrase pair lookup
struct PhrasePairHash {
    std::size_t operator()(const std::pair<std::string, std::string>& p) const {
        // Combine hashes of both strings
        std::size_t h1 = std::hash<std::string>{}(p.first);
        std::size_t h2 = std::hash<std::string>{}(p.second);
        return h1 ^ (h2 << 1);
    }
};

typedef std::unordered_set<std::pair<std::string, std::string>, PhrasePairHash> PhrasePairSet;

typedef struct
{
    char *tokens[MAX_TOKENS_PER_LINE];
    int num_tokens;
} TokenList;

// Global file mutex for safe file access
static pthread_mutex_t file_mutex = PTHREAD_MUTEX_INITIALIZER;

// Helper: split a line into tokens
TokenList split_tokens(char *line)
{
    TokenList tl = {.num_tokens = 0};
    char *token = strtok(line, " \t\n");
    while (token && tl.num_tokens < MAX_TOKENS_PER_LINE)
    {   
        char *tok_copy = strdup(token);
        if (!tok_copy) { fprintf(stderr, "Memory allocation failed\n"); break; }
        tl.tokens[tl.num_tokens++] = tok_copy;

        token = strtok(NULL, " \t\n");
        if (tl.num_tokens >= MAX_TOKENS_PER_LINE) { 
            printf("Warning: line has more than %d tokens, truncating.\n", MAX_TOKENS_PER_LINE);
            break; // Prevent overflow
        }
    }
    return tl;
}

// Free token list
void free_token_list(TokenList tl)
{
    for (int i = 0; i < tl.num_tokens; i++)
    {
        free(tl.tokens[i]);
    }
}

// Parse alignments "0-0 1-2 ..."
int parse_alignments(char *line, int reverse_direction, Alignment *alignments)
{
    int count = 0;
    char *token = strtok(line, " \t\n");
    while (token && count < MAX_ALIGNMENTS_PER_LINE)
    {
        int s, t;
        if (sscanf(token, "%d-%d", &s, &t) == 2)
        {
            if (reverse_direction) {
                alignments[count].src = t;
                alignments[count].tgt = s;
            }
            else {
                alignments[count].src = s;
                alignments[count].tgt = t;
            }
            count++;
        }
        token = strtok(NULL, " \t\n");
    }
    return count;
}

// Check if string is empty or only punctuation
int is_valid_phrase(const char *str)
{
    if (!str) return 0;

    // Find first non-space character
    int start = 0;
    while (str[start] && isspace((unsigned char)str[start])) {
        start++;
    }

    // If string is empty or only whitespace
    if (str[start] == '\0') return 0;

    // Find last non-space character
    int end = start;
    while (str[end] != '\0') {
        end++;
    }
    end--; // move to last character
    while (end >= start && isspace((unsigned char)str[end])) {
        end--;
    }

    if (end < start) return 0; // safety

    // Reject if first or last significant character is punctuation
    if (ispunct((unsigned char)str[start]) || ispunct((unsigned char)str[end])) {
        return 0;
    }

    return 1;
}


int get_phrases(TokenList src, TokenList tgt, Alignment *alignments, 
    int align_count, int min_len, int max_len, PhrasePairSet *phrases_to_ignore, Phrase *phrases)
{

    int phrase_count = 0;

    for (int length = min_len; length <= max_len; length++)
    {
        for (int start_src = 0; start_src <= src.num_tokens - length; start_src++)
        {

            // Find aligned tgt tokens with bounds checking
            int start_tgt = -1, end_tgt = -1;
            for (int i = 0; i < align_count; i++)
            {
                // Add bounds checking for alignment indices
                if (alignments[i].src >= 0 && alignments[i].src < src.num_tokens &&
                    alignments[i].tgt >= 0 && alignments[i].tgt < tgt.num_tokens &&
                    alignments[i].src >= start_src && alignments[i].src < start_src + length)
                {
                    if (start_tgt == -1 || alignments[i].tgt < start_tgt)
                        start_tgt = alignments[i].tgt;
                    if (alignments[i].tgt > end_tgt)
                        end_tgt = alignments[i].tgt;
                }
            }
            if (start_tgt == -1)
                continue; // no aligned target tokens
            end_tgt++;    // make it exclusive
            
            // Ensure target range is within bounds
            if (end_tgt > tgt.num_tokens)
                end_tgt = tgt.num_tokens;

            // Build phrase strings with bounds checking
            char src_phrase[MAX_PHRASE_LENGTH] = "";
            char tgt_phrase[MAX_PHRASE_LENGTH] = "";
            
            // Build source phrase safely
            for (int i = start_src; i < start_src + length && i < src.num_tokens; i++)
            {
                size_t current_len = strlen(src_phrase);
                size_t token_len = strlen(src.tokens[i]);
                size_t space_needed = token_len + (i < start_src + length - 1 ? 1 : 0); // +1 for space if not last
                
                if (current_len + space_needed < MAX_PHRASE_LENGTH - 1)
                {
                    strncat(src_phrase, src.tokens[i], MAX_PHRASE_LENGTH - current_len - 1);
                    if (i < start_src + length - 1)
                        strncat(src_phrase, " ", MAX_PHRASE_LENGTH - strlen(src_phrase) - 1);
                }
                else
                {
                    break; // Phrase too long, truncate
                }
            }
            
            // Build target phrase safely
            for (int i = start_tgt; i < end_tgt && i < tgt.num_tokens; i++)
            {
                size_t current_len = strlen(tgt_phrase);
                size_t token_len = strlen(tgt.tokens[i]);
                size_t space_needed = token_len + (i < end_tgt - 1 ? 1 : 0); // +1 for space if not last
                
                if (current_len + space_needed < MAX_PHRASE_LENGTH - 1)
                {
                    strncat(tgt_phrase, tgt.tokens[i], MAX_PHRASE_LENGTH - current_len - 1);
                    if (i < end_tgt - 1)
                        strncat(tgt_phrase, " ", MAX_PHRASE_LENGTH - strlen(tgt_phrase) - 1);
                }
                else
                {
                    break; // Phrase too long, truncate
                }
            }

            if (is_valid_phrase(src_phrase) && is_valid_phrase(tgt_phrase))
            {

                // check if phrase pair is in ignore list (O(1) hash lookup)
                if (phrases_to_ignore && 
                    phrases_to_ignore->find({src_phrase, tgt_phrase}) != phrases_to_ignore->end()) {
                    continue;
                }

                // also check if lower case of src_phrase and tgt_phrase is in ignore list
                std::string src_lower, tgt_lower;
                for (size_t i = 0; i < strlen(src_phrase); i++) {
                    src_lower += tolower(src_phrase[i]);
                }
                for (size_t i = 0; i < strlen(tgt_phrase); i++) {
                    tgt_lower += tolower(tgt_phrase[i]);
                }

                if (phrases_to_ignore && 
                    phrases_to_ignore->find({src_lower, tgt_lower}) != phrases_to_ignore->end()) {
                    continue;
                }

                phrases[phrase_count].src_phrase = strdup(src_phrase);
                phrases[phrase_count].tgt_phrase = strdup(tgt_phrase);
                phrase_count++;

                if (phrase_count >= MAX_PHRASES_PER_LINE)
                {
                    printf("Warning: reached max phrases per line (%d), truncating.\n", MAX_PHRASES_PER_LINE);
                    return phrase_count;
                }
            }
        }
    }
    return phrase_count;
}

// Thread args
typedef struct
{
    int thread_id;
    int start_index;
    int end_index;
    char **src_lines;
    char **tgt_lines;
    float *score_lines;
    char **align_lines;
    PhrasePairSet *phrases_to_ignore;
    float threshold;
    int min_phrase_length;
    int max_phrase_length;
    FILE *log_file;
    FILE *ignore_file;
    int reverse_direction; // 0: src->tgt, 1: tgt->src
} ThreadArgs;

pthread_mutex_t print_mutex = PTHREAD_MUTEX_INITIALIZER;

// ==== Thread worker ====
void *worker(void *arg)
{
    ThreadArgs *args = (ThreadArgs *)arg;
    int min_phrase_length = args->min_phrase_length;
    int max_phrase_length = args->max_phrase_length;
    float threshold = args->threshold;
    PhrasePairSet *phrases_to_ignore = args->phrases_to_ignore;

    FILE *log_file = args->log_file;
    FILE *ignore_file = args->ignore_file;

    for (int row_id = args->start_index; row_id < args->end_index; row_id++)
    {
         // Check only pointer types for NULL, not float array elements
        if (!args->src_lines[row_id] || !args->tgt_lines[row_id] || !args->align_lines[row_id]) {
            printf("Warning: Thread %d Missing data at line %d, skipping.\n", args->thread_id, row_id + 1);
            continue;
        }

        // score_lines is a float array, so we can always access it
        // Just check if the score_lines pointer itself exists
        if (!args->score_lines) {
            printf("Warning: Thread %d score_lines array is NULL\n", args->thread_id);
            continue;
        }


        float current_score = args->score_lines[row_id];
        
        TokenList src_tokens;
        TokenList tgt_tokens;

        if (args->reverse_direction) {
            src_tokens = split_tokens(args->tgt_lines[row_id]);
            tgt_tokens = split_tokens(args->src_lines[row_id]);
        } else {
            src_tokens = split_tokens(args->src_lines[row_id]);
            tgt_tokens = split_tokens(args->tgt_lines[row_id]);
        }

        Alignment alignments[MAX_ALIGNMENTS_PER_LINE];
        int align_count = parse_alignments(args->align_lines[row_id], args->reverse_direction, alignments);
        if (align_count == 0) {
            free_token_list(src_tokens);
            free_token_list(tgt_tokens);
            continue; // no alignments, skip
        }

        Phrase phrases[MAX_PHRASES_PER_LINE];
        int phrase_count = get_phrases(
            src_tokens, 
            tgt_tokens,
            alignments, 
            align_count, 
            min_phrase_length, 
            max_phrase_length, 
            phrases_to_ignore,
            phrases
        );

        if (phrase_count >  MAX_PHRASES_PER_LINE) {
            printf("Warning: Thread %d Line %d exceeded max phrases, truncating.\n", args->thread_id, row_id + 1);
            phrase_count = MAX_PHRASES_PER_LINE;
        }
        
        pthread_mutex_lock(&print_mutex);
        for (int j = 0; j < phrase_count; j++)
        {   
            // Add null pointer checks before writing
            if (phrases[j].src_phrase && phrases[j].tgt_phrase) {
                if (args->reverse_direction) {
                    if (current_score > threshold) {
                        fprintf(ignore_file, "%s|||%s\n", phrases[j].tgt_phrase, phrases[j].src_phrase);
                    } else {
                        fprintf(log_file, "%s|||%s|||%d\n", 
                            phrases[j].tgt_phrase, 
                            phrases[j].src_phrase, 
                            row_id
                        );
                    }
                } else {
                    if (current_score > threshold) {
                        fprintf(ignore_file, "%s|||%s\n", phrases[j].src_phrase, phrases[j].tgt_phrase);
                    } else {
                        fprintf(log_file, "%s|||%s|||%d\n",
                            phrases[j].src_phrase, 
                            phrases[j].tgt_phrase, 
                            row_id
                        );
                    }
                }
            }
            
            // Always free allocated memory, even if null
            if (phrases[j].src_phrase) {
                free(phrases[j].src_phrase);
                phrases[j].src_phrase = NULL;
            }
            if (phrases[j].tgt_phrase) {
                free(phrases[j].tgt_phrase);
                phrases[j].tgt_phrase = NULL;
            }
        }

        pthread_mutex_unlock(&print_mutex);

        free_token_list(src_tokens);
        free_token_list(tgt_tokens);
    }
    return NULL;
}

// ==== Parallel extraction ====
void extract_phrases_parallel(
    char **src_lines, 
    char **tgt_lines, 
    float *score_lines,
    char **align_lines, 
    int line_count, 
    PhrasePairSet *phrases_to_ignore,
    const char *output_file_path, 
    const char *output_ignore_file_path,
    int reverse_direction,
    float threshold = 1.0,
    int min_phrase_length = 1,
    int max_phrase_length = 3,
    const int num_cores = 4
) {

    // create empty output file
    FILE *out_file = fopen(output_file_path, "w");
    if (!out_file) {
        fprintf(stderr, "Error creating output file: %s\n", output_file_path);
        return;
    }

    FILE *ignore_file = fopen(output_ignore_file_path, "w");
    if (!ignore_file) {
        fprintf(stderr, "Error creating ignore file: %s\n", output_ignore_file_path);
        return;
    }

    int NUM_THREADS = num_cores; // adjust as needed

    pthread_t* threads = new pthread_t[NUM_THREADS];
    ThreadArgs* args = new ThreadArgs[NUM_THREADS];

    // // Make a safe local copy of the string
    char safe_path[256];
    snprintf(safe_path, sizeof(safe_path), "%s", output_file_path);

    char safe_ignore_path[256];
    snprintf(safe_ignore_path, sizeof(safe_ignore_path), "%s", output_ignore_file_path);

    int chunk_size = (line_count + NUM_THREADS - 1) / NUM_THREADS;

    // printf("Starting phrase extraction with %d threads with chunk size %d...\n", NUM_THREADS, chunk_size);

    for (int t = 0; t < NUM_THREADS; t++)
    {
        args[t].thread_id = t;
        args[t].start_index = t * chunk_size;
        args[t].end_index = (t + 1) * chunk_size;
        if (args[t].end_index > line_count)
            args[t].end_index = line_count;

        args[t].src_lines = src_lines;
        args[t].tgt_lines = tgt_lines;
        args[t].score_lines = score_lines;
        args[t].align_lines = align_lines;
        args[t].phrases_to_ignore = phrases_to_ignore;
        args[t].log_file = out_file;        // opened once in main
        args[t].ignore_file = ignore_file;  // same
        args[t].reverse_direction = reverse_direction;
        args[t].threshold = threshold; // set desired score threshold
        args[t].min_phrase_length = min_phrase_length; // set desired min phrase length
        args[t].max_phrase_length = max_phrase_length; // set desired max phrase length

        pthread_create(&threads[t], NULL, worker, &args[t]);
    }

    for (int t = 0; t < NUM_THREADS; t++)
    {
        pthread_join(threads[t], NULL);
    }

    //printf("Phrase extraction completed with %d threads.\n", NUM_THREADS);
    
    fclose(out_file);
    fclose(ignore_file);

    delete[] threads;
    delete[] args;
}

extern "C"
{
    EMSCRIPTEN_KEEPALIVE
    int extract_phrases_parallel_main(
        const char *src_file_path, 
        const char *tgt_file_path, 
        const char *score_file_path, 
        const char *align_file_path, 
        const char *input_ignore_file_path, 
        const char *output_file_path, 
        const char *output_ignore_file_path,
        int start_idx,
        int end_idx,
        int num_phrases_to_ignore,
        int reverse_direction,
        float threshold,
        int min_phrase_length,
        int max_phrase_length,
        const int num_cores
    )   {
        char **src_lines = NULL;
        char **tgt_lines = NULL;
        float *score_lines = NULL;
        char **align_lines = NULL;
        char line[MAX_LINE_LENGTH];  // Add this line declaration

        FILE *src_file = fopen(src_file_path, "r");
        FILE *tgt_file = fopen(tgt_file_path, "r");
        FILE *score_file = fopen(score_file_path, "r");
        FILE *align_file = fopen(align_file_path, "r");
        if (!src_file || !tgt_file || !score_file || !align_file)
        {
            fprintf(stderr, "Error opening input files.\n");
            return 1;
        }

        // Count lines in the source file
        int line_count = end_idx - start_idx;

        // Allocate memory for lines
        src_lines = (char **)calloc(line_count, sizeof(char *));
        tgt_lines = (char **)calloc(line_count, sizeof(char *));
        score_lines = (float *)calloc(line_count, sizeof(float));
        align_lines = (char **)calloc(line_count, sizeof(char *));
        
        if (!src_lines || !tgt_lines || !score_lines || !align_lines)
        {
            fprintf(stderr, "Memory allocation failed.\n");
            return 1;
        }

        // printf("Processing %d lines, from %d to %d...\n", line_count, start_idx, end_idx);
        
        // Read lines into arrays - need to fix the indexing logic
        int file_line_index = 0;
        int array_index = 0;
        
        while (array_index < line_count) {
            // Read from all files simultaneously
            char *src_result = fgets(line, sizeof(line), src_file);
            if (src_result && file_line_index >= start_idx && file_line_index < end_idx) {
                src_lines[array_index] = strdup(line);
            }
            
            char *tgt_result = fgets(line, sizeof(line), tgt_file);
            if (tgt_result && file_line_index >= start_idx && file_line_index < end_idx) {
                tgt_lines[array_index] = strdup(line);
            }
            
            char *score_result = fgets(line, sizeof(line), score_file);
            if (score_result && file_line_index >= start_idx && file_line_index < end_idx) {
                // Parse scores
                float score_value = 1.0f; // default fallback
                if (sscanf(line, "%f", &score_value) == 1) {
                    score_lines[array_index] = score_value;
                } else {
                    score_lines[array_index] = 1.0f; // fallback
                }
            }
            
            char *align_result = fgets(line, sizeof(line), align_file);
            if (align_result && file_line_index >= start_idx && file_line_index < end_idx) {
                align_lines[array_index] = strdup(line);
            }
            
            // Check if we've reached end of any file
            if (!src_result || !tgt_result || !score_result || !align_result) {
                break;
            }
            
            // Only increment array index if we're in the target range
            if (file_line_index >= start_idx && file_line_index < end_idx) {
                array_index++;
            }
            
            file_line_index++;
        }

        fclose(src_file);
        fclose(tgt_file);
        fclose(score_file);
        fclose(align_file);

        // read each phrase pair on input_ignore_file_path where they are stored as src_phrase|||tgt_phrase
        // and store them in a hash set for O(1) lookup during extraction
        FILE *input_ignore_file = fopen(input_ignore_file_path, "r");
        
        PhrasePairSet *phrases_to_ignore = new PhrasePairSet();
        phrases_to_ignore->reserve(num_phrases_to_ignore); // Pre-allocate for better performance
        
        if (input_ignore_file)
        {
            char ignore_line[MAX_LINE_LENGTH];
            while (fgets(ignore_line, sizeof(ignore_line), input_ignore_file))
            {
                // Parse the ignore line into src and tgt phrases
                char *src_phrase = strtok(ignore_line, "|||");
                char *tgt_phrase = strtok(NULL, "|||");

                // strip newline from tgt_phrase
                if (tgt_phrase) {
                    size_t len = strlen(tgt_phrase);
                    if (len > 0 && tgt_phrase[len - 1] == '\n') {
                        tgt_phrase[len - 1] = '\0';
                    }
                }

                if (src_phrase && tgt_phrase)
                {
                    // Insert into hash set for O(1) lookup
                    phrases_to_ignore->insert({std::string(src_phrase), std::string(tgt_phrase)});
                }
            }
            fclose(input_ignore_file);
        }

        extract_phrases_parallel(
            src_lines, 
            tgt_lines, 
            score_lines,
            align_lines, 
            line_count, 
            phrases_to_ignore,
            output_file_path, 
            output_ignore_file_path,
            reverse_direction,
            threshold,
            min_phrase_length,
            max_phrase_length,
            num_cores
        );

        for (int i = 0; i < line_count; i++)
        {
            if (src_lines[i]) free(src_lines[i]);
            if (tgt_lines[i]) free(tgt_lines[i]);
            if (align_lines[i]) free(align_lines[i]);
        }
        free(src_lines);
        free(tgt_lines);
        free(score_lines);
        free(align_lines);
        
        // Clean up hash set
        delete phrases_to_ignore;

        return 0;
    }
}