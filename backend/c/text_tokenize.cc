/*
 * Copyright 2025 Samuel Frontull and Simon Haller-Seeber, University of Innsbruck
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <pthread.h>
#include <emscripten/emscripten.h>
#include <string>
#include <vector>

#include "line_reader.h"

#define BLANK_TOKEN "#BL"
#define NO_BLANK_TOKEN "#NB"

// Split symbols
const char *SPLIT_SYMBOLS[] = {
    "'", "!", "\"", "$", "%", "&", "\\", "(", ")", ".", "*", "+", ";", "@", "^",
    "`", "_", "|", "~", "-", "]", "[", "}", "{", "€", "§", "<", ">", ";", "!",
    "'", "?", ",", "/", ":", "=", "»", "«"
};
const int NUM_SPLIT_SYMBOLS = sizeof(SPLIT_SYMBOLS) / sizeof(SPLIT_SYMBOLS[0]);

// Helper: Check if a string is in the split symbols
int is_split_symbol(const char *str) {
    for (int i = 0; i < NUM_SPLIT_SYMBOLS; i++) {
        if (strcmp(str, SPLIT_SYMBOLS[i]) == 0) {
            return 1;
        }
    }
    return 0;
}

int is_blank_token(const char *str) {
    return strcmp(str, BLANK_TOKEN) == 0;
}

// Normalize text using libunistring
void clean_text(const char *input, char *output, size_t output_size) {
 
        strncpy(output, input, output_size - 1);
        output[output_size - 1] = '\0';
 
}


char* tokenise(const char *text) {

    size_t len = strlen(text);
    size_t nb_len = strlen(NO_BLANK_TOKEN);
    size_t bufsize = len * (8 + nb_len*2) + 1; 
    // this should be a safe over-estimate of how large the string may become
    
    char *acc = (char *)malloc(bufsize);
    if (!acc) {
        return NULL;
    }
    acc[0] = '\0';  // empty input writes nothing below
    char *p = acc; // pointer to current write position

    for (size_t i = 0; i < len; i++) {
        char c = text[i];
        char s[2] = {c, '\0'}; // null-terminated string
        if (is_split_symbol(s)) {
            p += sprintf(p, " %s %c %s ", NO_BLANK_TOKEN, c, NO_BLANK_TOKEN); 
            // worst case: 4 blanks + 2 no blank tokens + symbol
        } else if (isspace(c)) {
            p += sprintf(p, " %s ", BLANK_TOKEN);
        } else {
            *p++ = c;
            *p = '\0';
        }
        if ((size_t)(p - acc) >= bufsize - 1) {
            fprintf(stderr, "Tokenization buffer overflow prevented\n");
            break;
        }
    }

    // now split acc into tokens by space (any number of tokens of any length;
    // fixed-size arrays used to cut tokens at 63 bytes and lines at 512 tokens)
    std::vector<std::string> tokens;

    char *saveptr = NULL;
    char *token = strtok_r(acc, " ", &saveptr);

    while (token) {
        if (strlen(token) > 0) {
            bool push = true;
            // Merge / overwrite logic
            if (!tokens.empty()) {
                std::string &prev = tokens.back();
                if (is_blank_token(token) && prev == NO_BLANK_TOKEN) {
                    prev = BLANK_TOKEN;   // NB followed by blank becomes a blank
                    push = false;
                } else if (strcmp(token, NO_BLANK_TOKEN) == 0 && is_blank_token(prev.c_str())) {
                    push = false;         // skip NB after a blank
                } else if (strcmp(token, NO_BLANK_TOKEN) == 0 && prev == NO_BLANK_TOKEN) {
                    push = false;         // skip duplicate NB
                }
            }
            if (push) tokens.push_back(token);
        }
        token = strtok_r(NULL, " ", &saveptr);
    }

    // === Join tokens back ===
    std::string joined;
    int token_count = (int)tokens.size();
    for (int i = 0; i < token_count; i++) {
        // Blanks are only separators
        if (is_blank_token(tokens[i].c_str())) {
            continue;
        }

        // Skip final NB
        if (i == token_count - 1 && tokens[i] == NO_BLANK_TOKEN)
            continue;

        joined += tokens[i];
        if (i < token_count - 1) {
            joined += ' ';
        }
    }

    free(acc);
    return strdup(joined.c_str());

}

// Thread args
typedef struct
{
    int thread_id;
    int start_index;
    int end_index;
    char **lines;
    const char *output_file_path;
} ThreadArgs;

pthread_mutex_t print_mutex = PTHREAD_MUTEX_INITIALIZER;

// ==== Thread worker ====
void *worker(void *arg)
{
    ThreadArgs *args = (ThreadArgs *)arg;

    // Buffer to store tokenised lines locally
    char **tokenised_lines = (char **)malloc((args->end_index - args->start_index) * sizeof(char*));
    if (!tokenised_lines) {
        fprintf(stderr, "Memory allocation failed for tokenised_lines\n");
        return NULL;
    }
    int tokenised_count = 0;
    // Line index of each tokenised line (lines that are NULL are skipped)
    int *line_indices = (int *)malloc((args->end_index - args->start_index + 1) * sizeof(int));
    if (!line_indices) {
        fprintf(stderr, "Memory allocation failed for line_indices\n");
        free(tokenised_lines);
        return NULL;
    }

    // Tokenise each line locally without locking
    for (int row_id = args->start_index; row_id < args->end_index; row_id++)
    {
        if (!args->lines[row_id])
            continue;

        line_indices[tokenised_count] = row_id;
        char *tokenised = tokenise(args->lines[row_id]);
        tokenised_lines[tokenised_count++] = tokenised ? tokenised : strdup("");
    }

    // Now write all lines to the file at once while holding the mutex
    pthread_mutex_lock(&print_mutex);

    FILE *log_file = fopen(args->output_file_path, "a");
    if (!log_file)
    {
        fprintf(stderr, "Error opening %s file.\n", args->output_file_path);
        pthread_mutex_unlock(&print_mutex);
        // Free allocated memory before returning
        for (int i = 0; i < tokenised_count; i++)
            free(tokenised_lines[i]);
        free(tokenised_lines);
        free(line_indices);
        return NULL;
    }

    for (int i = 0; i < tokenised_count; i++)
    {
        fprintf(log_file, "%d|||%s\n", line_indices[i], tokenised_lines[i]);
        free(tokenised_lines[i]);  // free each line after writing
    }
    free(tokenised_lines);
    free(line_indices);

    fclose(log_file);
    pthread_mutex_unlock(&print_mutex);

    return NULL;
}


// ==== Parallel extraction ====
void tokenize_parallel(
    char **lines,
    int line_count,
    const char *output_file_path,
    int num_cores = 4
) {

    int NUM_THREADS = num_cores; // adjust as needed

    pthread_t* threads = new pthread_t[NUM_THREADS];
    ThreadArgs* args = new ThreadArgs[NUM_THREADS];

    // create empty output file
    FILE *out_file = fopen(output_file_path, "w");
    if (!out_file) {
        fprintf(stderr, "Error creating output file: %s\n", output_file_path);
        return;
    }
    fclose(out_file);

    printf("Starting tokenization with %d threads...\n", NUM_THREADS);

    int chunk_size = (line_count + NUM_THREADS - 1) / NUM_THREADS;

    for (int t = 0; t < NUM_THREADS; t++)
    {
        args[t].thread_id = t;
        args[t].start_index = t * chunk_size;
        args[t].end_index = (t + 1) * chunk_size;
        if (args[t].end_index > line_count)
            args[t].end_index = line_count;
        if (args[t].start_index > args[t].end_index)
            args[t].start_index = args[t].end_index;  // more threads than lines
        args[t].lines = lines;
        args[t].output_file_path = output_file_path;

        pthread_create(&threads[t], NULL, worker, &args[t]);
    }

    for (int t = 0; t < NUM_THREADS; t++)
    {
        pthread_join(threads[t], NULL);
    }

    delete[] threads;
    delete[] args;
}


extern "C" {
EMSCRIPTEN_KEEPALIVE
int tokenize_file(const char *input_file, const char *output_file, const int num_cores) {
    FILE *in_file = fopen(input_file, "r");
    if (!in_file) {
        fprintf(stderr, "Error opening input file: %s\n", input_file);
        return 1; // Return 1 for file open error
    }

    // read lines into an array
    char **lines = NULL;
    size_t lines_allocated = 0;
    size_t line_count = 0;
    char *buffer;

    while ((buffer = read_line(in_file)) != NULL) {
        // Allocate more space if needed
        if (line_count >= lines_allocated) {
            lines_allocated = lines_allocated ? lines_allocated * 2 : 16;
            lines = (char **)realloc(lines, lines_allocated * sizeof(char *));
        }

        // Store the line (read_line allocates it)
        lines[line_count] = buffer;
        line_count++;
    }

    printf("Read %zu lines from %s\n", line_count, input_file);

    // call parallel tokenize function here
    tokenize_parallel(lines, line_count, output_file, num_cores);

    // free lines
    for (size_t i = 0; i < line_count; i++) {
        free(lines[i]);
    }
    free(lines);
    fclose(in_file);

    return 0; // Return 0 for success
}
}


// int main() {
    
//     // read content of file /home/samuel/uibk/research/ladinmt/lldmt-ifi-cluster/corpus/motorola/deu-lld.deu.txt
//     const char *input_file = "/home/samuel/uibk/research/ladinmt/lldmt-ifi-cluster/corpus/motorola/deu-lld.lld.txt";
//     FILE *in_file = fopen(input_file, "r");
//     if (!in_file) {
//         fprintf(stderr, "Error opening input file: %s\n", input_file);
//         return 1;
//     }

//     // read lines into an array
//     char **test_strings = NULL;
//     size_t strings_allocated = 0;
//     size_t string_count = 0;
//     char buffer[MAX_LINE_LENGTH];   
//     while (fgets(buffer, sizeof(buffer), in_file)) {
//         // Remove trailing newline
//         buffer[strcspn(buffer, "\r\n")] = '\0';
//         buffer[strcspn(buffer, "\n")] = '\0';

//         // Allocate more space if needed
//         if (string_count >= strings_allocated) {
//             strings_allocated = strings_allocated ? strings_allocated * 2 : 16;
//             test_strings = (char **)realloc(test_strings, strings_allocated * sizeof(char *));
//         }

//         // Store a copy of the line
//         test_strings[string_count] = strdup(buffer);
//         string_count++;
//     }

//     // tokenize each string in parallel and write to output file
//     const char *output_file = "tokenized_output.txt";
//     tokenize_parallel(test_strings, string_count, output_file, 8);

//     // free test_strings
//     for (size_t i = 0; i < string_count; i++) {
//         free(test_strings[i]);
//     }
//     free(test_strings);

//     return 0;
// }
