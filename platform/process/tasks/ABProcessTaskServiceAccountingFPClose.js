const path = require("path");
// prettier-ignore
const AccountingFPCloseCore = require(path.join(__dirname, "..", "..", "..", "core", "process","tasks", "ABProcessTaskServiceAccountingFPCloseCore.js"));

module.exports = class AccountingFPClose extends AccountingFPCloseCore {
   ////
   //// Process Instance Methods
   ////

   /**
    * do()
    * this method actually performs the action for this task.
    * @param {obj} instance  the instance data of the running process
    * @param {Knex.Transaction?} trx - [optional]
    * @param {ABUtil.reqService} req
    *        an instance of the current request object for performing tenant
    *        based operations.
    * @return {Promise}
    *      resolve(true/false) : true if the task is completed.
    *                            false if task is still waiting
    */
   do(instance, trx, req) {
      this.fpObject = this.AB.objects((o) => o.id == this.objectFP)[0];
      this.glObject = this.AB.objects((o) => o.id == this.objectGL)[0];
      this.accObject = this.AB.objects((o) => o.id == this.objectAcc)[0];
      this._req = req;

      return new Promise((resolve, reject) => {
         var myState = this.myState(instance);

         var currentProcessValues = this.hashProcessDataValues(instance);
         var currentFPID = currentProcessValues[this.processFPValue];
         if (!currentFPID) {
            this.log(instance, "unable to find relevant Fiscal Period ID");
            var error = new Error(
               "AccountingFPClose.do(): unable to find relevant Fiscal Period ID"
            );
            reject(error);
            return;
         }

         // find the next fiscal month(.startDate == my.endDate + 1)
         var cond = {
            where: {
               glue: "and",
               rules: [
                  {
                     key: this.fpObject.PK(),
                     rule: "equals",
                     value: currentFPID,
                  },
               ],
            },
            populate: true,
         };

         Promise.resolve()
            .then(() => {
               return this.fpObject
                  .model()
                  .findAll(cond, null, req)
                  .then((rows) => {
                     this.currentFP = rows[0];
                     this.log(instance, "Found FPObj");
                     this.log(instance, rows);
                  })
                  .catch((err) => {
                     reject(err);
                  });
            })
            .then(() =>
               new Promise((next, fail) => {
                  // make sure exists FP
                  if (this.currentFP == null) {
                     this.log(instance, `Count not find FP: ${currentFPID}`);
                     return next();
                  }

                  // Pull the .Start field for use to search the next FP
                  let startField = this.fpObject.fields(
                     (f) => f.id == this.fieldFPStart
                  )[0];
                  if (startField == null) {
                     this.log(instance, `Count not find the .Start field`);
                     return next();
                  }

                  // Pull the .Open field for use to search the next FP
                  let openField = this.fpObject.fields(
                     (f) => f.id == this.fieldFPOpen
                  )[0];
                  if (openField == null) {
                     this.log(instance, `Count not find the .Open field`);
                     return next();
                  }

                  // find the next fiscal month(.startDate == my.endDate + 1)
                  // .open = true
                  // .status = active
                  let startDate = null;
                  if (this.currentFP.End) {
                     if (!(this.currentFP.End instanceof Date)) {
                        startDate = new Date(this.currentFP.End);
                     } else {
                        startDate = _.clone(this.currentFP.End);
                     }

                     // add 1 day
                     startDate.setDate(startDate.getDate() + 1);

                     if (startField.key == "date")
                        startDate = this.AB.rules.toSQLDate(startDate);
                  }
                  this.fpObject
                     .model()
                     .findAll(
                        {
                           where: {
                              glue: "and",
                              rules: [
                                 {
                                    key: startField.id,
                                    rule: "equals",
                                    value: startDate,
                                 },
                                 {
                                    key: openField.id,
                                    rule: "equals",
                                    value: 1,
                                 },
                              ],
                           },
                           populate: true,
                        },
                        null,
                        req
                     )
                     .then((rows) => {
                        this.nextFP = rows[0];
                        this.log(instance, "Found the next FPObj");
                        this.log(instance, rows);
                        next();
                     })
                     .catch((err) => {
                        fail(err);
                        reject(err);
                     });
               }).then(
                  () =>
                     new Promise((next, fail) => {
                        // make sure exists FP
                        if (this.currentFP == null) {
                           return next();
                        }

                        // make sure exists next FP
                        if (this.nextFP == null) {
                           this.log(instance, "Count not find next FP");
                           return next();
                        }

                        if (this.glObject == null) {
                           this.log(instance, "GL object is undefined");
                           return next();
                        }

                        let fieldFPLink = this.fpObject.fields(
                           (f) =>
                              f.key == "connectObject" &&
                              f.settings.linkObject == this.glObject.id
                        )[0];
                        if (fieldFPLink == null) {
                           this.log(instance, "GL connect field is undefined");
                           return next();
                        }

                        let fieldGLlink = this.glObject.fields(
                           (f) =>
                              f.key == "connectObject" &&
                              f.settings.linkObject == this.fpObject.id
                        )[0];
                        let fieldGLStarting = this.glObject.fields(
                           (f) => f.id == this.fieldGLStarting
                        )[0];
                        let fieldGLRunning = this.glObject.fields(
                           (f) => f.id == this.fieldGLRunning
                        )[0];
                        let fieldGLAccount = this.glObject.fields(
                           (f) => f.id == this.fieldGLAccount
                        )[0];
                        let fieldGLRc = this.glObject.fields(
                           (f) => f.id == this.fieldGLRc
                        )[0];
                        let fieldGLDebit = this.glObject.fields(
                           (f) => f.id == this.fieldGLDebit
                        )[0];
                        let fieldGLCredit = this.glObject.fields(
                           (f) => f.id == this.fieldGLCredit
                        )[0];
                        let fieldAccType = this.accObject.fields(
                           (f) => f.id == this.fieldAccType
                        )[0];

                        let linkName = fieldFPLink.relationName();
                        let tasks = [];

                        (this.currentFP[linkName] || []).forEach(
                           (glSegment) => {
                              // Check if the Next Balance Exists (with same RC, Account, Fiscal Month +1)
                              let nextGlSegment = (
                                 this.nextFP[linkName] || []
                              ).filter((nextGl) => {
                                 let isExists = false;

                                 if (fieldGLRc) {
                                    isExists =
                                       nextGl[fieldGLRc.columnName] ==
                                       glSegment[fieldGLRc.columnName];
                                 }

                                 if (isExists && fieldGLAccount) {
                                    isExists =
                                       nextGl[fieldGLAccount.columnName] ==
                                       glSegment[fieldGLAccount.columnName];
                                 }

                                 return isExists;
                              })[0];

                              // Update the exists Balance
                              if (nextGlSegment) {
                                 tasks.push(
                                    Promise.resolve()
                                       .then(() =>
                                          this.glObject.model().findAll(
                                             {
                                                where: {
                                                   glue: "and",
                                                   rules: [
                                                      {
                                                         key: this.glObject.PK(),
                                                         rule: "equals",
                                                         value:
                                                            nextGlSegment[
                                                               this.glObject.PK()
                                                            ],
                                                      },
                                                   ],
                                                },
                                                populate: true,
                                             },
                                             null,
                                             req
                                          )
                                       )
                                       .then((nextGlInfo) => {
                                          // array to a object
                                          nextGlInfo =
                                             nextGlInfo[0] || nextGlInfo;

                                          let updateExistsVals = {};

                                          // Update the Next Balance > Starting Balance = Original Balance > Running Balance
                                          if (fieldGLStarting) {
                                             updateExistsVals[
                                                fieldGLStarting.columnName
                                             ] =
                                                glSegment[
                                                   fieldGLRunning.columnName
                                                ];

                                             // Calculate Next Balance > Running Balance
                                             if (fieldGLRunning) {
                                                let glAccount =
                                                   nextGlInfo[
                                                      fieldGLAccount.relationName()
                                                   ] || {};

                                                if (
                                                   glAccount &&
                                                   Array.isArray(glAccount)
                                                )
                                                   glAccount = glAccount[0];

                                                switch (
                                                   glAccount[fieldAccType]
                                                ) {
                                                   // If account category is Asset or Expense: Running Balance = Starting Balance + Debit - Credit
                                                   case this.fieldAccAsset:
                                                   case this.fieldAccExpense:
                                                      updateExistsVals[
                                                         fieldGLRunning.columnName
                                                      ] =
                                                         updateExistsVals[
                                                            fieldGLStarting
                                                               .columnName
                                                         ] +
                                                         nextGlInfo[
                                                            fieldGLDebit
                                                               .columnName
                                                         ] -
                                                         nextGlInfo[
                                                            fieldGLCredit
                                                               .columnName
                                                         ];
                                                      break;
                                                   // If account category is Liabilities, Equity, Income: Running Balance = Starting Balance - Debit + Credit
                                                   case this
                                                      .fieldAccLiabilities:
                                                   case this.fieldAccEquity:
                                                   case this.fieldAccIncome:
                                                      updateExistsVals[
                                                         fieldGLRunning.columnName
                                                      ] =
                                                         updateExistsVals[
                                                            fieldGLStarting
                                                               .columnName
                                                         ] -
                                                         nextGlInfo[
                                                            fieldGLDebit
                                                               .columnName
                                                         ] +
                                                         nextGlInfo[
                                                            fieldGLCredit
                                                               .columnName
                                                         ];
                                                      break;
                                                }
                                             }
                                          }

                                          this.glObject
                                             .model()
                                             .update(
                                                nextGlSegment[
                                                   this.glObject.PK()
                                                ],
                                                updateExistsVals,
                                                null,
                                                trx
                                             )
                                             .then((updatedExistsGl) => {
                                                // sails.sockets.broadcast(
                                                //    this.glObject.id,
                                                //    "ab.datacollection.update",
                                                //    {
                                                //       objectId: this.glObject
                                                //          .id,
                                                //       data: updatedExistsGl,
                                                //    }
                                                // );

                                                this._req.broadcast.dcUpdate(
                                                   this.glObject.id,
                                                   updatedExistsGl
                                                );

                                                return Promise.resolve();
                                             })
                                             .catch(fail);
                                       })
                                 );
                              }
                              // Create a new Balance
                              else {
                                 let newGL = {};
                                 newGL[this.glObject.PK()] = this.AB.uuid();

                                 // link to the next FP
                                 if (fieldGLlink) {
                                    newGL[
                                       fieldGLlink.columnName
                                    ] = fieldGLlink.getRelationValue(
                                       this.nextFP
                                    );
                                 }

                                 // set Starting & Running Balance
                                 if (fieldGLRunning) {
                                    if (fieldGLStarting) {
                                       newGL[fieldGLStarting.columnName] =
                                          glSegment[fieldGLRunning.columnName];
                                    }
                                    newGL[fieldGLRunning.columnName] =
                                       glSegment[fieldGLRunning.columnName];
                                 }

                                 // set link to Account
                                 if (fieldGLAccount) {
                                    newGL[fieldGLAccount.columnName] =
                                       glSegment[fieldGLAccount.columnName];
                                 }

                                 // set link to RC
                                 if (fieldGLRc) {
                                    newGL[fieldGLRc.columnName] =
                                       glSegment[fieldGLRc.columnName];
                                 }

                                 // make a new GLSegment ( same Account & RC + new FiscalMonth)
                                 tasks.push(
                                    new Promise((ok, bad) => {
                                       this.glObject
                                          .model()
                                          .create(newGL)
                                          .then((newGLResult) => {
                                             if (!this.nextFP[linkName])
                                                this.nextFP[linkName] = [];

                                             this.nextFP[linkName].push(
                                                newGLResult
                                             );

                                             // Broadcast the create
                                             // sails.sockets.broadcast(
                                             //    this.glObject.id,
                                             //    "ab.datacollection.create",
                                             //    newGLResult
                                             // );
                                             this._req.broadcast
                                                .dcCreate(
                                                   this.glObject.id,
                                                   newGLResult
                                                )
                                                .then(ok)
                                                .catch(bad);
                                          })
                                          .catch(bad);
                                    })
                                 );
                              }
                           }
                        );

                        Promise.all(tasks)
                           .then(() => {
                              next();
                           })
                           .catch(fail);
                     })
               )
            )
            // Set the next FP 'Status' field to 'Active'
            .then(
               () =>
                  new Promise((next, fail) => {
                     // make sure exists next FP
                     if (this.nextFP == null) {
                        this.log(instance, "Count not found next FP");
                        return next();
                     }

                     if (this.fieldFPStatus == null) {
                        this.log(
                           instance,
                           "FP status field does not be defined"
                        );
                        return next();
                     }

                     let fieldStatus = this.fpObject.fields(
                        (f) => f.id == this.fieldFPStatus
                     )[0];
                     if (fieldStatus == null) {
                        this.log(instance, "Could not found FP status field");
                        return next();
                     }

                     if (this.fieldFPActive == null) {
                        this.log(
                           instance,
                           "Active value option does not be defined"
                        );
                        return next();
                     }

                     let nextFpID = this.nextFP[this.fpObject.PK()];
                     let values = {};
                     values[fieldStatus.columnName] = this.fieldFPActive;

                     this.fpObject
                        .model()
                        .update(nextFpID, values, null, trx)
                        .then((updatedNextFP) => {
                           // Broadcast
                           // sails.sockets.broadcast(
                           //    this.fpObject.id,
                           //    "ab.datacollection.update",
                           //    {
                           //       objectId: this.fpObject.id,
                           //       data: updatedNextFP,
                           //    }
                           // );

                           this._req.broadcast
                              .dcUpdate(
                                 this.fpObject.id,
                                 updatedNextFP,
                                 "broadcast.fp.update"
                              )
                              .then(next)
                              .catch(fail);
                        })
                        .catch(fail);
                  })
            )
            // Final step
            .then(() => {
               this.log(instance, "I'm done.");
               this.stateCompleted(instance);
               resolve(true);
            });
      });
   }
};
