/**
 * Copyright 2015 Google Inc. All rights reserved.
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

(function(global) {
  // Use a cache for the Picasa API response for the Google I/O photo album.
  // global.toolbox.router.get('/data/feed/api/user/(.*)',
  // global.toolbox.networkFirst, {origin: /https?:\/\/picasaweb.google.com/});
  // Use a cache for the actual image files as well.
  global.toolbox.router.get('/(.+)', global.toolbox.networkFirst,
    {origin: /https?:\/\/lh\d*.googleusercontent.com/});
})(self);
