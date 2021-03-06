const path = require("path");
// prettier-ignore
const ABProcessTaskUserCore = require(path.join(__dirname, "..", "..", "..", "core", "process", "tasks", "ABProcessTaskUserCore.js"));

module.exports = class ABProcessTaskUser extends ABProcessTaskUserCore {
   ////
   //// Process Instance Methods
   ////

   /**
    * do()
    * this method actually performs the action for this task.
    * @param {obj} instance  the instance data of the running process
    * @return {Promise}
    *      resolve(true/false) : true if the task is completed.
    *                            false if task is still waiting
    */
   do(instance) {
      return new Promise((resolve, reject) => {
         // err objects are returned as simple {} not instances of {Error}
         var error = new Error("Generic UserTask has nothing to do.");
         reject(error);
         return;
      });
   }
};
