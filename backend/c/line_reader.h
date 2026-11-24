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

#ifndef ALIGNFIX_LINE_READER_H
#define ALIGNFIX_LINE_READER_H

#include <stdio.h>
#include <stdlib.h>
#include <sys/types.h>

// Read one line of any length, without the trailing "\n" or "\r\n".
// Returns a malloc'd string (free() it), or NULL at end of file.
// (fgets() with a fixed buffer split long lines into several, which shifted
// every following line onto the wrong sentence pair.)
static inline char *read_line(FILE *file)
{
    char *buffer = NULL;
    size_t capacity = 0;
    ssize_t length = getline(&buffer, &capacity, file);
    if (length < 0) {
        free(buffer);
        return NULL;
    }
    while (length > 0 && (buffer[length - 1] == '\n' || buffer[length - 1] == '\r')) {
        buffer[--length] = '\0';
    }
    return buffer;
}

#endif
