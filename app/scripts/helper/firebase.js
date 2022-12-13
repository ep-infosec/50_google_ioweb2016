/**
 * Copyright 2016 Google Inc. All rights reserved.
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
'use strict';

window.IOWA = window.IOWA || {};

/**
 * Firebase for the I/O Web App.
 */
class IOFirebase {

  constructor() {
    /**
     * Currently authorized Firebase Database shard.
     * @type {Firebase}
     */
    this.firebaseRef = null;

    /**
     * Offset between the local clock and the Firebase servers clock. This is used to replay offline
     * operations accurately.
     * @type {number}
     */
    this.clockOffset = 0;

    /**
     * Stores callbacks that we should call when we become authenticated
     * @type {Set<function>}
     */
    this.authCallbacks = [];

    // Disconnect Firebase while the focus is off the page to save battery.
    if (typeof document.hidden !== 'undefined') {
      document.addEventListener('visibilitychange',
          () => document.hidden ? IOFirebase.goOffline() : IOFirebase.goOnline());
    }
  }

  /**
   * Selects the correct Firebase Database shard for the given user.
   *
   * @static
   * @private
   * @param {string} userId The ID of the signed-in Google user.
   * @return {string} The URL of the Firebase Database shard.
   */
  static _selectShard(userId) {
    let shardIndex = parseInt(crc32(userId), 16) % window.FIREBASE_SHARDS.length;
    return window.FIREBASE_SHARDS[shardIndex];
  }

  /**
   * Authorizes the given user to the correct Firebase Database shard.
   *
   * @param {string} userId The ID of the signed-in Google user.
   * @param {string} accessToken The accessToken of the signed-in Google user.
   * @return {Promise} Fulfills when auth is successful.
   */
  auth(userId, accessToken) {
    let firebaseShardUrl = IOFirebase._selectShard(userId);
    debugLog('Chose the following Firebase Database Shard:', firebaseShardUrl);
    this.firebaseRef = new Firebase(firebaseShardUrl);

    return this._setClockOffset()
      .then(() => this.firebaseRef.authWithOAuthToken('google', accessToken))
      .then(() => {
        IOWA.Analytics.trackEvent('login', 'success', firebaseShardUrl);
        debugLog('Authenticated successfully to Firebase shard', firebaseShardUrl);

        this.authCallbacks.forEach(cb => cb());

        return this._bumpLastActivityTimestamp().then(() => {
          // Check to see if there are any failed session modification requests,
          // and if so, replay them before fetching the user schedule.
          return this._replayQueuedOperations();
        }).then(() => {
          IOWA.Schedule.loadUserSchedule();
        });
      }).catch(error => {
        IOWA.Analytics.trackError('firebaseRef.authWithOAuthToken(...)', error);
        debugLog('Login to Firebase Failed!', error);
      });
  }

  /**
   * Unauthorizes Firebase and clears out the IndexedDB entries.
   */
  unAuth() {
    if (this.firebaseRef) {
      // Make sure to detach any callbacks.
      let userId = this.firebaseRef.getAuth().uid;
      this.firebaseRef.child(`users/${userId}/web_notifications_enabled`).off();
      this.firebaseRef.child(`data/${userId}/my_sessions`).off();
      this.firebaseRef.child(`data/${userId}/feedback_submitted_sessions`).off();
      this.firebaseRef.child(`data/${userId}/viewed_videos`).off();
      // Unauthorize the Firebase reference.
      this.firebaseRef.unauth();
      debugLog('Unauthorized Firebase');
      this.firebaseRef = null;
    }

    // Clear out IndexedDB and the session UI.
    this.clearCachedReads();
    this.clearCachedUpdates();
    IOWA.Schedule.clearUserSchedule();
  }

  /**
   * Retries all queued Firebase set() operations that were previously queued
   * in IndexedDB.
   *
   * @private
   * @return {Promise} Fulfills when all the queued operations are replayed.
   */
  _replayQueuedOperations() {
    let queuedOperations = {};

    return IOWA.SimpleDB.instance(IOWA.SimpleDB.NAMES.UPDATES).then(db => {
      // Let's read in all the queued values before we do anything else, to
      // make sure we're not confused by additional queued values that get
      // added asynchronously.
      return db.forEach((attribute, value) => {
        queuedOperations[attribute] = value;
      });
    }).then(() => {
      return Promise.all(Object.keys(queuedOperations).map(attribute => {
        // _setFirebaseData() will take care of deleting the IDB entry.
        return this._setFirebaseData(attribute, queuedOperations[attribute]);
      }));
    }).then(results => {
      // Only display the toast if the Promise.all() from the previous step
      // fulfilled with a value, since there might not be anything replayed.
      if (results && results.length) {
        IOWA.Elements.Toast.showMessage('My Schedule was updated with offline changes.');
      }
    }).catch(error => {
      debugLog('Error in _replayQueuedOperations: ' + error);
    });
  }

  /**
   * Updates the offset between the local clock and the Firebase servers clock.
   * @private
   * @return {Promise} Promise fulfilled when the clock has been set. The
   *     resolve value is the offset.
   */
  _setClockOffset() {
    // Retrieve the offset between the local clock and Firebase's clock for
    // offline operations.
    let offsetRef = this.firebaseRef.child('/.info/serverTimeOffset');
    return offsetRef.once('value').then(snap => {
      this.clockOffset = snap.val();
      debugLog('Updated clockOffset to', this.clockOffset, 'ms');
    });
  }

  /**
   * Update the user's last activity timestamp and make sure it will be updated when the user
   * disconnects. Also marks the user as having used the Web App.
   *
   * @private
   * @return {Promise} Promise to track completion.
   */
  _bumpLastActivityTimestamp() {
    let userId = this.firebaseRef.getAuth().uid;
    let operations = [
      this.firebaseRef.child(`users/${userId}/last_activity_timestamp`)
          .onDisconnect().set(Firebase.ServerValue.TIMESTAMP),
      this._setFirebaseUserData('users', 'used_web_app', true),
      this._setFirebaseUserData('users', 'last_activity_timestamp',
          Firebase.ServerValue.TIMESTAMP)];
    return Promise.all(operations);
  }

  /**
   * Disconnect Firebase.
   * @static
   */
  static goOffline() {
    Firebase.goOffline();
    debugLog('Firebase went offline.');
  }

  /**
   * Re-connect to the Firebase backend.
   * @static
   */
  static goOnline() {
    Firebase.goOnline();
    debugLog('Firebase back online!');
  }

  /**
   * Register to get updates on the notification preference. This should also be used to get the initial value.
   *
   * @param {IOFirebase~updateCallback} callback A callback function that will be called with the
   *     value when the notification preference changes.
   */
  registerToNotificationUpdates(callback) {
    const register = () => {
      const userId = this.firebaseRef.getAuth().uid;
      this.firebaseRef.child(`users/${userId}/web_notifications_enabled`)
          .on('value', s => callback(s.val()));
    };

    if (this.isAuthed()) {
      register();
    }
    this.authCallbacks.push(register);
  }

  /**
   * Register to get updates on bookmarked sessions. This should also be used to get the initial
   * list of bookmarked sessions.
   *
   * @param {IOFirebase~updateCallback} callback A callback function that will be called with the
   *     data for each sessions when they get updated.
   */
  registerToSessionUpdates(callback) {
    this._registerToUpdates('data', 'my_sessions', callback);
  }

  /**
   * Register to get updates on saved session feedback. This should also be used to get the initial
   * list of saved session feedback.
   *
   * @param {IOFirebase~updateCallback} callback A callback function that will be called with the
   *     data for each saved session feedback when they get updated.
   */
  registerToFeedbackUpdates(callback) {
    this._registerToUpdates('data', 'feedback_submitted_sessions', callback);
  }

  /**
   * Register to get updates on session videos the user has watched. This
   * should also be used to get the initial list of videos watched by the user.
   *
   * @param {IOFirebase~updateCallback} callback Called when the list of watched
   *     videos changes.
   */
  registerToVideoWatchUpdates(callback) {
    this._registerToUpdates('data', 'viewed_videos', callback);
  }

  /**
   * Clears out the data in the READS IndexedDB datastore.
   *
   * @returns {Promise} Fulfills when the IndexedDB data is cleared.
   */
  clearCachedReads() {
    return IOWA.SimpleDB.clearData(IOWA.SimpleDB.NAMES.READS);
  }

  /**
   * Clears out the data in the UPDATES IndexedDB datastore.
   *
   * @returns {Promise} Fulfills when the IndexedDB data is cleared.
   */
  clearCachedUpdates() {
    return IOWA.SimpleDB.clearData(IOWA.SimpleDB.NAMES.UPDATES);
  }

  /**
   * Replays the cached My Sessions data from IndexedDB.
   *
   * @param callback The callback to invoke for each piece of cached data
   * @returns {Promise} Fulfills when the replay is complete
   */
  replayCachedSavedSessions(callback) {
    return this._replayCachedData('my_sessions', callback);
  }

  /**
   * Replays the cached session feedback data from IndexedDB.
   *
   * @param callback The callback to invoke for each piece of cached data
   * @returns {Promise} Fulfills when the replay is complete
   */
  replayCachedSessionFeedback(callback) {
    return this._replayCachedData('feedback_submitted_sessions', callback);
  }

  /**
   * Invokes callback for every IndexedDB entry that corresponds to the Firebase
   * ref location.
   *
   * @param refSubstring A URL representing a Firebase location ref
   * @param callback The callback to invoke for each piece of cached data
   * @returns {Promise} Fulfills when the replay is complete
   */
  _replayCachedData(refSubstring, callback) {
    return IOWA.SimpleDB.instance(IOWA.SimpleDB.NAMES.READS).then(db => {
      let firebaseUrlRegexp = new RegExp(`${refSubstring}.*?([^/]+)$`);
      return db.forEach((cacheKey, cachedValue) => {
        if (cachedValue) {
          let matches = cacheKey.match(firebaseUrlRegexp);
          if (matches) {
            // matches[1] represents the first capture group, which will
            // contain the equivalent of the key (all the characters after the
            // final / up until the end of the string.)
            callback(matches[1], cachedValue);
          }
        }
      });
    }).catch(error => {
      debugLog('SimpleDB error while reading cache data:', error);
    });
  }

  /**
   * Register to get updates on the given user data attribute.
   * If there's a previously cached value for the attribute in IndexedDB, then
   * invoke the callback with that first.
   * Every time there's an update to the underlying Firebase data, write the
   * current value to IndexedDB.
   *
   * @private
   * @param {string} subtree The top level subtree `data` or `users`.
   * @param {string} attribute The Firebase user data attribute for which updated will trigger the
   *     callback.
   * @param {IOFirebase~updateCallback} callback A callback function that will be called for each
   *     updates/deletion/addition of an item in the given attribute.
   */
  _registerToUpdates(subtree, attribute, callback) {
    if (this.isAuthed()) {
      let userId = this.firebaseRef.getAuth().uid;
      let ref = this.firebaseRef.child(`${subtree}/${userId}/${attribute}`);
      let refString = ref.toString();

      // wrappedCallback takes care of storing a "shadow" IndexedDB  copy of
      // the data that's being read from Firebase, and then invokes the actual
      // callback to allow that data to be consumed.
      let wrappedCallback = (key, freshValue) => {
        // Lexical this ftw!
        return IOWA.SimpleDB.instance(IOWA.SimpleDB.NAMES.READS).then(db => {
          return db.set(`${refString}/${key}`, freshValue);
        }).catch(error => {
          debugLog('SimpleDB error in wrappedCallback:', error);
        }).then(() => {
          return callback(key, freshValue);
        });
      };

      ref.on('child_added', dataSnapshot => {
        wrappedCallback(dataSnapshot.key(), dataSnapshot.val());
      });
      ref.on('child_changed', dataSnapshot => {
        wrappedCallback(dataSnapshot.key(), dataSnapshot.val());
      });
      ref.on('child_removed', dataSnapshot => {
        wrappedCallback(dataSnapshot.key(), null);
      });
    } else {
      debugLog('Trying to subscribe to Firebase while not authorized.');
    }
  }

  /**
   * Callback used to notify updates.
   *
   * @callback IOFirebase~updateCallback
   * @param {string} key The key of the element that was updated/added/deleted.
   * @param {string|null} value The value given to the updated element. `null` if the element was
   *     deleted.
   */

  /**
   * Adds or remove the given session to the user's schedule.
   *
   * @param {string} sessionUUID The session's UUID.
   * @param {boolean} inSchedule `true` if the user has bookmarked the session.
   * @return {Promise} Promise to track completion.
   */
  toggleSession(sessionUUID, inSchedule) {
    return this._setFirebaseUserData('data', `my_sessions/${sessionUUID}`, {
      timestamp: Date.now() + this.clockOffset,
      in_schedule: inSchedule
    });
  }

  /**
   * Mark the given video as viewed by the user.
   *
   * @param {string} videoIdOrUrl The Youtube Video URL or ID.
   * @return {Promise} Promise to track completion.
   */
  markVideoAsViewed(videoIdOrUrl) {
    // Making sure we save the ID of the video and not the full Youtube URL.
    let match = videoIdOrUrl.match(/.*(?:youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=)([^#\&\?]*).*/);
    let videoId = match ? match[1] : videoIdOrUrl;
    return this._setFirebaseUserData('data', `viewed_videos/${videoId}`, true);
  }

  /**
   * Adds the push subscription ID provided by the browser.
   *
   * @param {PushSubscription} subscription The subscription data.
   * @return {Promise} Promise to track completion.
   */
  addPushSubscription(subscription) {
    if (!(subscription instanceof PushSubscription)) {
      return Promise.reject('Tried to add invalid subscription details to Firebase');
    }
    const key = crc32(subscription.endpoint);
    // We need to turn the PushSubscription into a simple object
    const value = JSON.stringify(subscription);
    return this._setFirebaseUserData('users', `web_push_subscriptions/${key}`, value);
  }

  /**
   * Set the flag that determines if notifications are enabled for this user
   *
   * @param {boolean} value What to set the flag to
   * @return {Promise} A promise that resolves when the update completes
   */
  setNotificationsEnabled(value) {
    return this._setFirebaseUserData('users', 'web_notifications_enabled', !!value);
  }

  /**
   * Queues a write operation to IndexedDB (via the SimpleDB wrapper).
   * This ensures that if the Firebase connection is unavailable, the write
   * operation will be eventually performed.
   *
   * @private
   * @param {string} attribute
   * @param {Object} value
   * @return {Promise} Promise that fulfills once IDB is updated.
   */
  _queueOperation(attribute, value) {
    return IOWA.SimpleDB.instance(IOWA.SimpleDB.NAMES.UPDATES).then(db => {
      return db.set(attribute, value);
    }).catch(error => {
      // This might have rejected if IndexedDB is unavailable in the current
      // browser, or if writing to IndexedDB failed for some reason. That should
      // not prevent the Firebase write from being attempted, though, so just
      // catch() the error here.
      debugLog('Error in IOFirebase._queueOperation()', error);
    });
  }

  /**
   * Dequeues a previously queued write operation to IndexedDB (via the SimpleDB
   * wrapper).
   * This should be called after the Firebase operation completed successfully.
   *
   * @private
   * @param {string} attribute
   * @return {Promise} Promise that fulfills once IDB is updated.
   */
  _dequeueOperation(attribute) {
    return IOWA.SimpleDB.instance(IOWA.SimpleDB.NAMES.UPDATES).then(db => {
      return db.delete(attribute);
    }).catch(error => {
      // This might have rejected if IndexedDB is unavailable in the current
      // browser, or if writing to IndexedDB failed for some reason.
      debugLog('Error in IOFirebase._dequeueOperation()', error);
    });
  }

  /**
   * Sets the given attribute of Firebase user data to the given value.
   *
   * @private
   * @param {string} subtree The top level subtree `data` or `user`.
   * @param {string} attribute The attribute to update in the user's data.
   * @param {Object} value The value to give to the attribute.
   * @return {Promise} Promise to track set() success or failure.
   */
  _setFirebaseUserData(subtree, attribute, value) {
    if (this.isAuthed()) {
      // If we're auth'ed, use the fresh uid.
      let userId = this.firebaseRef.getAuth().uid;
      return this._setFirebaseData(`${subtree}/${userId}/${attribute}`, value);
    } else if (IOWA.Elements.Template.app.currentUser &&
               IOWA.Elements.Template.app.currentUser.id) {
      // If we're not auth'ed but we have a cached uid, use that to queue an
      // update that will be replayed the next time we start up online.
      // The uid returned by Firebase is equal to the currentUser.id value
      // with the 'google:' prefix.
      // This is specific to the current version of Firebase!
      let cachedUserId = 'google:' + IOWA.Elements.Template.app.currentUser.id;
      return this._queueOperation(`${subtree}/${cachedUserId}/${attribute}`, value);
    }

    return Promise.reject('Not currently authorized with Firebase.');
  }

  /**
   * Sets the given attribute of Firebase data to the given value.
   *
   * @private
   * @param {string} attribute The attribute to update.
   * @param {Object} value The value to give to the attribute.
   * @return {Promise} Promise to track set() success or failure.
   */
  _setFirebaseData(attribute, value) {
    let ref = this.firebaseRef.child(attribute);

    return this._queueOperation(attribute, value).then(() => {
      return ref.set(value);
    }).then(() => {
      debugLog(`Success: Firebase.set(${ref}) with value ` +
        JSON.stringify(value));
      return this._dequeueOperation(attribute);
    }, error => {
      debugLog(`Failure: Firebase.set(${ref}) with value ` +
        `${JSON.stringify(value)} failed due to ${error}`);
      // Even if Firebase returned an error, we still want to remove the
      // queued operation from IDB, since it's not going to help to retry it.
      return this._dequeueOperation(attribute).then(() => Promise.reject(error));
    });
  }

  /**
   * Returns `true` if a user has authorized to Firebase.
   *
   * @return {boolean} `true` if a user has authorized to Firebase.
   */
  isAuthed() {
    return this.firebaseRef && this.firebaseRef.getAuth();
  }
}

IOWA.IOFirebase = IOWA.IOFirebase || new IOFirebase();
